import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { EsportaThrottlerGuard } from './common/guards/esporta-throttler.guard';
import { SecurityHeadersMiddleware } from './common/middleware/security-headers.middleware';
import { LoggerModule } from './common/logger/logger.module';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { ProfilesModule } from './profiles/profiles.module';
import { TeamsModule } from './teams/teams.module';
import { PostsModule } from './posts/posts.module';
import { CommentsModule } from './comments/comments.module';
import { ReactionsModule } from './reactions/reactions.module';
import { FollowsModule } from './follows/follows.module';
import { SearchModule } from './search/search.module';
import { LookupsModule } from './lookups/lookups.module';
import { RecruitmentModule } from './recruitment/recruitment.module';
import { ApplicationsModule } from './applications/applications.module';
import { SponsorshipsModule } from './sponsorships/sponsorships.module';
import { TryoutsModule } from './tryouts/tryouts.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PushModule } from './push/push.module';
import { SecurityModule } from './security/security.module';
import { MediaModule } from './media/media.module';
import { PlatformModule } from './platform/platform.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { EmailModule } from './email/email.module';
import { InternalModule } from './internal/internal.module';
import { AdminModule } from './admin/admin.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { RecommendationModule } from './recommendation/recommendation.module';
import { PublicModule } from './public/public.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

import { SupportModule } from './support/support.module';
import { ReportsModule } from './reports/reports.module';

/**
 * Root module. Wires the Phase-1 foundation (config, logging, Supabase, health)
 * and Phase-2 auth. Feature modules (profiles, teams, posts, …) are added here as
 * later phases land — the plumbing below applies to all of them uniformly.
 */
@Module({
  imports: [
    AppConfigModule,
    LoggerModule,
    SupabaseModule,
    // Rate limiter plumbing (STEP 1 security baseline): one named throttler
    // whose storage/options the {@link EsportaThrottlerGuard} override needs.
    // The guard resolves the real per-tier limit from validated env config at
    // request time, so this nominal entry only seeds the storage contract and
    // never throttles by itself.
    ThrottlerModule.forRootAsync({
      imports: [],
      useFactory: () => ({
        throttlers: [{ name: 'esporta', ttl: 60_000, limit: 1 }],
      }),
    }),
    AuthModule,
    HealthModule,
    ProfilesModule,
    TeamsModule,
    PostsModule,
    CommentsModule,
    ReactionsModule,
    FollowsModule,
    SearchModule,
    LookupsModule,
    RecruitmentModule,
    ApplicationsModule,
    SponsorshipsModule,
    TryoutsModule,
    NotificationsModule,
    PushModule,
    SecurityModule,
    MediaModule,
    PlatformModule,
    WebhooksModule,
    EmailModule,
    InternalModule,
    AdminModule,
    AnalyticsModule,
    RecommendationModule,
    PublicModule,
    SupportModule,
    ReportsModule,
  ],
  providers: [
    // Rate limiting (STEP 1 security baseline) is a global guard so it runs
    // before every controller, alongside the global JWT guard from AuthModule.
    { provide: APP_GUARD, useClass: EsportaThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
    // Baseline security headers on every response (complements helmet's
    // express-level defaults applied in bootstrap.ts).
    consumer.apply(SecurityHeadersMiddleware).forRoutes('*');
  }
}
