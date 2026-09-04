import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Injectable()
export class SupportService {
  constructor(private readonly supabase: SupabaseService) {}

  faqs(token: string) {
    return this.supabase.run(
      this.supabase.asCaller(token).from('faqs')
        .select('id, question, answer, category, sort_order')
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true })
    );
  }

  myTickets(token: string, userId: string) {
    return this.supabase.run(
      this.supabase.asCaller(token).from('support_tickets')
        .select('id, subject, reason, status, last_message_at, created_at')
        .eq('requester_id', userId)
        .order('last_message_at', { ascending: false })
    );
  }

  ticket(token: string, id: string) {
    return this.supabase.run(
      this.supabase.asCaller(token).from('support_tickets')
        .select('id, subject, reason, status, last_message_at, created_at')
        .eq('id', id)
        .maybeSingle()
    );
  }

  messages(token: string, id: string) {
    return this.supabase.run(
      this.supabase.asCaller(token).from('support_ticket_messages')
        .select('id, body, from_admin, created_at')
        .eq('ticket_id', id)
        .order('created_at', { ascending: true })
    );
  }

  submitTicket(token: string, subject: string, reason: string, description: string) {
    return this.supabase.rpcAsCaller(token, 'submit_support_ticket', {
      p_subject: subject,
      p_reason: reason,
      p_description: description,
    });
  }
}
