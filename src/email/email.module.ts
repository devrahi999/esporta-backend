import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailOutboxService } from './email-outbox.service';

/**
 * Global so security / account-recovery / health can all send through the single
 * SMTP transporter. {@link EmailOutboxService} drains `public.email_outbox`, which
 * is how the DB security RPCs hand mail to the backend now that no Edge Function
 * is involved.
 */
@Global()
@Module({
  providers: [EmailService, EmailOutboxService],
  exports: [EmailService, EmailOutboxService],
})
export class EmailModule {}
