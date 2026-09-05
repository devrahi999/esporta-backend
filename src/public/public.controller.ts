import { Controller, Get, Header, Param } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { AppException } from '../common/errors/app-exception';
import {
  LINK_SEGMENTS,
  type LinkPreview,
  type LinkSegment,
  PublicService,
} from './public.service';

/**
 * `/api/v1/public` — the only unauthenticated *read* surface in this API.
 *
 * It exists for one caller: the `app.esporta.site` website, which must render a
 * preview of a shared Esporta link for somebody who does not have the app
 * installed and is not signed in. Android App Links and iOS Universal Links hand
 * the URL to the app when it is installed; when it is not, the browser loads the
 * page, and the page has no session to read with.
 *
 * Security posture, since `@Public()` switches off the global JWT guard:
 *
 * * Reads run as the `anon` Postgres role ({@link PublicService}), so RLS decides
 *   what exists. This route cannot see more than a signed-out phone could.
 * * The projection is preview-only and hand-written — it is not a general post or
 *   profile read, and must not grow into one.
 * * Anything the `anon` role cannot see returns the same 404 as a nonexistent id,
 *   so the endpoint never confirms that a private post exists.
 * * It is a plain GET with no side effects and no user input beyond a UUID.
 *
 * **Not rate limited.** There is no throttler in this service, so the abuse
 * ceiling is currently set by the CDN: the `Cache-Control` below lets Vercel
 * answer repeat hits at the edge, and the website additionally revalidates on its
 * own interval, so normal traffic reaches Postgres once per resource per minute.
 * A deliberate flood would still land on Postgres — see the deployment notes in
 * `esporta-deeplinking/DEEPLINK_EXTERNAL_SETUP.md`.
 */
@Public()
@Controller('public')
export class PublicController {
  constructor(private readonly preview: PublicService) {}

  /**
   * `GET /api/v1/public/preview/:kind/:id` where `kind` is `p`, `s`, `pp` or `op`
   * — the same four segments the canonical links use, passed straight through
   * from the URL the website was asked for.
   *
   * `s-maxage` is what keeps this cheap. `max-age=0` keeps browsers out of it so
   * a caption edit is visible on the next scrape, while the shared CDN copy
   * absorbs the repeat traffic that a link going around a Discord server
   * produces.
   */
  @Header('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=600')
  @Get('preview/:kind/:id')
  resolve(@Param('kind') kind: string, @Param('id') id: string): Promise<LinkPreview> {
    if (!isLinkSegment(kind)) throw AppException.notFound('Not found.');
    return this.preview.resolve(kind, id);
  }
}

function isLinkSegment(value: string): value is LinkSegment {
  return (LINK_SEGMENTS as readonly string[]).includes(value);
}
