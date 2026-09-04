import { Module } from '@nestjs/common';
import { AdminUsersController } from './admin-users.controller';
import { AdminContentController } from './admin-content.controller';
import { AdminSupportController } from './admin-support.controller';
import { AdminMetaController } from './admin-meta.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';

/**
 * Admin API (plan §26). One service wraps every capability-gated `admin_*` RPC;
 * controllers are grouped by domain; AdminGuard fronts the whole surface. This is
 * the single API `core-admin` (and future Engine/Analytics admins) will call
 * instead of touching the DB directly.
 */
@Module({
  controllers: [
    AdminUsersController,
    AdminContentController,
    AdminSupportController,
    AdminMetaController,
  ],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
