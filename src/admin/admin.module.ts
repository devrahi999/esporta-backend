import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller';
import { AdminContentController } from './admin-content.controller';
import { AdminSupportController } from './admin-support.controller';
import { AdminMetaController } from './admin-meta.controller';
import { AdminPlatformController } from './admin-platform.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';
import { PlatformModule } from '../platform/platform.module';
import { MediaModule } from '../media/media.module';

/**
 * Admin API (plan §26). One service wraps every capability-gated `admin_*` RPC;
 * controllers are grouped by domain; AdminGuard fronts the whole surface. This is
 * the single API `core-admin` (and future Engine/Analytics admins) will call
 * instead of touching the DB directly.
 *
 * `PlatformModule` is imported so control changes can invalidate the policy
 * cache the write-path guards read — a flipped switch must be enforced on the
 * very next request, not after the TTL. `MediaModule` is imported for the
 * permanent-delete flow, which purges real R2/Stream objects before the RPC
 * removes the rows.
 */
@Module({
  imports: [PlatformModule, MediaModule],
  controllers: [
    AdminUsersController,
    AdminContentController,
    AdminSupportController,
    AdminMetaController,
    AdminPlatformController,
  ],
  providers: [AdminService, AdminGuard],
  exports: [AdminService],
})
export class AdminModule {}
