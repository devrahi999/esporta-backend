import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard } from './guards/admin.guard';
import { AccessToken } from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors/app-exception';
import { isUuid } from '../common/utils/uuid';
import {
  AdminApplicationsQuery,
  AdminCommentsQuery,
  AdminPostsQuery,
  AdminRecruitmentsQuery,
  AdminReportsQuery,
  AdminTryoutsQuery,
  ModerateDto,
  ResolveReportDto,
} from './dto/admin.dto';

function uuid(id: string, label = 'id'): void {
  if (!isUuid(id)) throw AppException.validation(`Invalid ${label}.`);
}

/**
 * `/api/v1/admin` — content moderation: posts, comments, recruitments,
 * applications, tryouts, and reports.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminContentController {
  constructor(private readonly admin: AdminService) {}

  @Get('posts') posts(@AccessToken() t: string, @Query() q: AdminPostsQuery) { return this.admin.posts(t, q); }
  @Get('posts/:id') postDetail(@AccessToken() t: string, @Param('id') id: string) {
    uuid(id, 'post id');
    return this.admin.postDetail(t, id);
  }
  @Post('posts/:id/moderate') moderatePost(@AccessToken() t: string, @Param('id') id: string, @Body() dto: ModerateDto) {
    uuid(id, 'post id');
    return this.admin.moderatePost(t, id, dto.action, dto.reason);
  }

  @Get('comments') comments(@AccessToken() t: string, @Query() q: AdminCommentsQuery) { return this.admin.comments(t, q); }
  @Get('comments/:id') commentDetail(@AccessToken() t: string, @Param('id') id: string) {
    uuid(id, 'comment id');
    return this.admin.commentDetail(t, id);
  }
  @Post('comments/:id/moderate') moderateComment(@AccessToken() t: string, @Param('id') id: string, @Body() dto: ModerateDto) {
    uuid(id, 'comment id');
    return this.admin.moderateComment(t, id, dto.action, dto.reason);
  }

  @Get('recruitments') recruitments(@AccessToken() t: string, @Query() q: AdminRecruitmentsQuery) { return this.admin.recruitments(t, q); }
  @Get('recruitments/:id') recruitmentDetail(@AccessToken() t: string, @Param('id') id: string) {
    uuid(id, 'recruitment id');
    return this.admin.recruitmentDetail(t, id);
  }
  @Post('recruitments/:id/moderate') moderateRecruitment(@AccessToken() t: string, @Param('id') id: string, @Body() dto: ModerateDto) {
    uuid(id, 'recruitment id');
    return this.admin.moderateRecruitment(t, id, dto.action, dto.reason);
  }

  @Get('applications') applications(@AccessToken() t: string, @Query() q: AdminApplicationsQuery) { return this.admin.applications(t, q); }
  @Get('applications/:id') applicationDetail(@AccessToken() t: string, @Param('id') id: string) {
    uuid(id, 'application id');
    return this.admin.applicationDetail(t, id);
  }

  @Get('tryouts') tryouts(@AccessToken() t: string, @Query() q: AdminTryoutsQuery) { return this.admin.tryouts(t, q); }
  @Get('tryouts/:id') tryoutDetail(@AccessToken() t: string, @Param('id') id: string) {
    uuid(id, 'tryout id');
    return this.admin.tryoutDetail(t, id);
  }

  @Get('reports') reports(@AccessToken() t: string, @Query() q: AdminReportsQuery) { return this.admin.reports(t, q); }
  @Get('reports/:id') reportDetail(@AccessToken() t: string, @Param('id') id: string) {
    uuid(id, 'report id');
    return this.admin.reportDetail(t, id);
  }
  @Post('reports/:id/resolve') resolveReport(@AccessToken() t: string, @Param('id') id: string, @Body() dto: ResolveReportDto) {
    uuid(id, 'report id');
    return this.admin.resolveReport(t, id, dto.status, dto.note);
  }
}
