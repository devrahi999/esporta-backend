import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AppException } from '../common/errors/app-exception';

/**
 * The four link families `app.esporta.site` publishes, as the URL spells them.
 * Mirrors `EsportaLinkKind` in the Flutter app (`lib/core/services/esporta_links.dart`)
 * so the website can hand a path segment straight through.
 */
export const LINK_SEGMENTS = ['p', 's', 'pp', 'op'] as const;
export type LinkSegment = (typeof LINK_SEGMENTS)[number];

export type PreviewKind = 'post' | 'short' | 'personal_profile' | 'other_profile';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_TYPE = 'short';

// Deliberately narrower than `PostsService.POST_COLUMNS`. This answer is served
// to anyone on the internet, so it carries only what a link preview renders —
// no recruitment embed, no share counter, no storage paths.
const POST_PREVIEW_COLUMNS = `
  id, type_id, caption, created_at, reactions_count, comments_count,
  identities!posts_author_id_fkey(id, kind, username, display_name, avatar_url, verified),
  media(media_type, public_url, thumbnail_url, width, height, duration_seconds, position, deleted_at)
`;

const PERSONAL_PREVIEW_COLUMNS = `
  id, kind, username, display_name, avatar_url, cover_url, short_bio, bio,
  country, city, verified, followers_count, created_at,
  profiles!inner(primary_role_id)
`;

const TEAM_PREVIEW_COLUMNS = `
  id, kind, username, display_name, avatar_url, cover_url, short_bio, bio,
  country, city, verified, followers_count, created_at,
  teams!teams_id_fkey!inner(tag, category_id, primary_game_id, members_count, recruiting)
`;

interface MediaRow {
  media_type: string | null;
  public_url: string | null;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  position: number | null;
  deleted_at: string | null;
}

interface AuthorRow {
  id: string;
  kind: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  verified: boolean | null;
}

interface PostRow {
  id: string;
  type_id: string | null;
  caption: string | null;
  created_at: string;
  reactions_count: number | null;
  comments_count: number | null;
  identities: AuthorRow | null;
  media: MediaRow[] | null;
}

interface IdentityRow {
  id: string;
  kind: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  short_bio: string | null;
  bio: string | null;
  country: string | null;
  city: string | null;
  verified: boolean | null;
  followers_count: number | null;
  created_at: string;
  profiles?: { primary_role_id: string | null } | null;
  teams?: {
    tag: string | null;
    category_id: string | null;
    primary_game_id: string | null;
    members_count: number | null;
    recruiting: boolean | null;
  } | null;
}

export interface PreviewMedia {
  media_type: string | null;
  url: string | null;
  thumbnail_url: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
}

export interface LinkPreview {
  kind: PreviewKind;
  id: string;
  /** The canonical path for what was actually found — see {@link resolve}. */
  path: string;
  title: string;
  description: string | null;
  /** Best single image for an `og:image`, or null when there is none. */
  image: string | null;
  post?: {
    caption: string | null;
    created_at: string;
    reactions_count: number;
    comments_count: number;
    media: PreviewMedia[];
    author: {
      id: string;
      kind: string;
      username: string | null;
      display_name: string | null;
      avatar_url: string | null;
      verified: boolean;
    };
  };
  profile?: {
    identity_kind: string;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    cover_url: string | null;
    short_bio: string | null;
    bio: string | null;
    country: string | null;
    city: string | null;
    verified: boolean;
    followers_count: number;
    created_at: string;
    role_id: string | null;
    category_id: string | null;
    tag: string | null;
    members_count: number | null;
    recruiting: boolean | null;
  };
}

/**
 * Link previews for signed-out callers — what `app.esporta.site` renders when a
 * canonical Esporta URL is opened in a browser instead of being intercepted by
 * the installed app.
 *
 * **Every read here goes through {@link SupabaseService.anon}, and that is the
 * whole security model.** The `anon` Postgres role sees exactly one slice:
 * `posts` that are `visibility = 'public'` and not soft-deleted, `identities`
 * that are not `deleted`, and the `media` hanging off a post it can already see
 * (the media policy's `EXISTS (select 1 from posts …)` is itself RLS-filtered, so
 * a private post's attachments are invisible without a second check here). A
 * followers-only post, a `team_only` post and a deleted identity are therefore
 * *unreachable* rather than merely filtered — the same 404 a nonexistent id gets,
 * which is also the answer that leaks nothing about whether the row exists.
 *
 * Nothing in this service takes a token, and it must stay that way: the moment a
 * caller could influence the row set, the endpoint would stop being cacheable by
 * the website and start being an authorization surface.
 */
@Injectable()
export class PublicService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Resolves one canonical link to its preview.
   *
   * The path segment is a **hint, not a fact** — deliberately the same contract
   * the app's resolver has: `/pp/<team-id>` and `/op/<personal-id>` both resolve,
   * because a link built with the wrong prefix should still open the right page.
   * `path` on the result is the canonical location of what was actually found, so
   * a caller can emit a correct `og:url` without following a redirect.
   */
  async resolve(segment: LinkSegment, id: string): Promise<LinkPreview> {
    // A malformed id is a dead link, not a bad request: the browser is showing
    // whatever somebody pasted, and PostgREST would otherwise raise 22P02.
    if (!UUID_RE.test(id)) throw AppException.notFound('Not found.');
    return segment === 'p' || segment === 's'
      ? this.post(id)
      : this.identity(id, segment === 'pp' ? 'personal' : 'team');
  }

  private async post(id: string): Promise<LinkPreview> {
    const row = await this.supabase.run<PostRow | null>(
      this.supabase.anon().from('posts').select(POST_PREVIEW_COLUMNS).eq('id', id).maybeSingle(),
    );
    if (!row) throw AppException.notFound('Not found.');

    const isShort = row.type_id === SHORT_TYPE;
    const media = (row.media ?? [])
      .filter((m) => m.deleted_at === null)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map<PreviewMedia>((m) => ({
        media_type: m.media_type,
        url: m.public_url,
        thumbnail_url: m.thumbnail_url,
        width: m.width,
        height: m.height,
        duration_seconds: m.duration_seconds,
      }));

    const author = row.identities;
    const authorName = author?.display_name || author?.username || 'Esporta';
    const caption = row.caption?.trim() || null;

    return {
      kind: isShort ? 'short' : 'post',
      id: row.id,
      path: `/${isShort ? 's' : 'p'}/${row.id}`,
      title: `${authorName} on Esporta`,
      description: caption,
      // A video's poster frame is the only thing worth putting in an OG card, so
      // prefer a thumbnail over the asset itself and never fall back to a raw
      // video URL — scrapers render it as a broken image.
      image:
        media.find((m) => m.thumbnail_url)?.thumbnail_url ??
        media.find((m) => m.media_type === 'image' && m.url)?.url ??
        author?.avatar_url ??
        null,
      post: {
        caption,
        created_at: row.created_at,
        reactions_count: row.reactions_count ?? 0,
        comments_count: row.comments_count ?? 0,
        media,
        author: {
          id: author?.id ?? '',
          kind: author?.kind ?? 'personal',
          username: author?.username ?? null,
          display_name: author?.display_name ?? null,
          avatar_url: author?.avatar_url ?? null,
          verified: author?.verified === true,
        },
      },
    };
  }

  /**
   * Reads an identity as the claimed kind, then as the other one.
   *
   * Two queries rather than one because the projections differ: a personal
   * identity's extra fields live in `profiles`, a non-personal one's in `teams`,
   * and each embed is `!inner` so it doubles as the kind check.
   */
  private async identity(id: string, claimed: 'personal' | 'team'): Promise<LinkPreview> {
    const row =
      (await this.identityAs(id, claimed)) ??
      (await this.identityAs(id, claimed === 'personal' ? 'team' : 'personal'));
    if (!row) throw AppException.notFound('Not found.');

    const isPersonal = row.kind === 'personal';
    const name = row.display_name || row.username || 'Esporta';
    const handle = row.username ? `@${row.username}` : null;
    const where = [row.city, row.country].filter(Boolean).join(', ') || null;

    return {
      kind: isPersonal ? 'personal_profile' : 'other_profile',
      id: row.id,
      path: `/${isPersonal ? 'pp' : 'op'}/${row.id}`,
      title: handle ? `${name} (${handle}) on Esporta` : `${name} on Esporta`,
      description: row.short_bio?.trim() || row.bio?.trim() || where,
      image: row.cover_url ?? row.avatar_url ?? null,
      profile: {
        identity_kind: row.kind,
        username: row.username,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        cover_url: row.cover_url,
        short_bio: row.short_bio,
        bio: row.bio,
        country: row.country,
        city: row.city,
        verified: row.verified === true,
        followers_count: row.followers_count ?? 0,
        created_at: row.created_at,
        role_id: row.profiles?.primary_role_id ?? null,
        category_id: row.teams?.category_id ?? null,
        tag: row.teams?.tag ?? null,
        members_count: row.teams?.members_count ?? null,
        recruiting: row.teams?.recruiting ?? null,
      },
    };
  }

  private identityAs(id: string, kind: 'personal' | 'team'): Promise<IdentityRow | null> {
    return this.supabase.run<IdentityRow | null>(
      this.supabase
        .anon()
        .from('identities')
        .select(kind === 'personal' ? PERSONAL_PREVIEW_COLUMNS : TEAM_PREVIEW_COLUMNS)
        .eq('id', id)
        .eq('kind', kind)
        .maybeSingle(),
    );
  }
}
