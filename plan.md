Production architecture-এ আমি এই model-টাই recommend করি:
 `Flutter    │    ├── Supabase Auth → login / OTP / MFA / session    │    └── Dedicated API → all application data/business logic                            │                            ├── Supabase PostgreSQL                            ├── R2                            ├── Cloudflare Stream                            └── FCM / Email ` 
এতে password/client authentication flow safe থাকে, আর application data-এর জন্য একটাই controlled API layer থাকে।
  
# Esporta Dedicated Backend — Master Implementation Plan
 
## 1. Final Backend Stack
 
### Runtime / framework
 
**Node.js + TypeScript + NestJS**
 
Deployment:
 
**Vercel**
 
Database:
 
**Existing Supabase PostgreSQL**
 
Auth:
 
**Existing Supabase Auth**
 
Authorization:
 
**NestJS guards + existing PostgreSQL RLS**
 
Realtime:
 
**Existing Supabase Realtime where appropriate**
 
Images:
 
**Cloudflare R2**
 
Videos / Shorts:
 
**Cloudflare Stream**
 
Push:
 
**Firebase Cloud Messaging**
 
Email:
 
**Gmail SMTP through backend**
 
Caching:
 
**None initially**
 
Queue:
 
**None initially**
 
Search:
 
**PostgreSQL / existing search architecture**
 
Redis/OpenSearch/Kafka:
 
**Not now**
  
# 2. Core architectural rule
 
Backend হবে:
 
 
**Esporta-এর only application/business API layer**
 
 
Flutter-এর জন্য:
 `Flutter    ↓ HTTPS    ↓ NestJS Backend    ↓ Supabase / R2 / Stream / FCM ` 
Flutter থেকে direct:
 `❌ Supabase.from(...) ❌ direct post insert/update ❌ direct R2 secret ❌ direct Stream API secret ❌ direct FCM API ❌ admin/service-role operation ` 
এগুলো নতুন architecture-এ থাকবে না।
  
# 3. Existing Database — DO NOT REBUILD
 
এটা খুব গুরুত্বপূর্ণ।
 
বর্তমান Supabase database already structured:
 
 
- users/auth relationship
 
- profiles
 
- team profiles
 
- posts
 
- Shorts
 
- comments
 
- reactions
 
- follows
 
- applications
 
- recruitment
 
- tryouts
 
- notifications
 
- security
 
- team permissions
 
- audit/security tables
 
- settings
 
- existing RLS
 
- existing RPCs/triggers
 

 
**এসব redesign করবে না।**
 
Backend existing schema-এর উপর বসবে।
 
প্রথম কাজ হবে:
 
### Schema audit
 
Backend developer আগে inspect করবে:
 `Tables Relationships FKs Indexes RLS RPCs Triggers Views Storage references Notification triggers Security functions ` 
তারপর একটা mapping document বানাবে:
 `Feature → Existing table(s) → Existing RPC(s) → Backend service `  
# 4. Backend Repository Structure
 
NestJS project-টা modular হবে।
 
আমি এভাবে রাখতাম:
 `esporta-backend/ │ ├── src/ │   │ │   ├── main.ts │   ├── app.module.ts │   │ │   ├── config/ │   │   ├── env.config.ts │   │   └── validation.ts │   │ │   ├── auth/ │   │   ├── auth.controller.ts │   │   ├── auth.service.ts │   │   ├── auth.guard.ts │   │   └── auth.types.ts │   │ │   ├── users/ │   ├── profiles/ │   ├── teams/ │   ├── posts/ │   ├── comments/ │   ├── reactions/ │   ├── follows/ │   ├── recruitment/ │   ├── applications/ │   ├── tryouts/ │   ├── notifications/ │   ├── security/ │   ├── support/ │   │ │   ├── media/ │   │   ├── media.service.ts │   │   ├── media.controller.ts │   │   ├── providers/ │   │   │   ├── r2.provider.ts │   │   │   └── stream.provider.ts │   │   └── media.types.ts │   │ │   ├── storage/ │   ├── push/ │   ├── email/ │   ├── webhooks/ │   │   └── stream/ │   │ │   ├── admin/ │   ├── analytics/ │   ├── common/ │   │   ├── guards/ │   │   ├── decorators/ │   │   ├── interceptors/ │   │   ├── filters/ │   │   └── utils/ │   │ │   └── health/ │ ├── test/ ├── Dockerfile ├── package.json ├── tsconfig.json ├── vercel.json └── .env.example `  
# 5. Backend layers
 
প্রতিটা feature ideally এই structure অনুসরণ করবে:
 `Controller    ↓ Service    ↓ Repository/Data Access    ↓ Supabase ` 
উদাহরণ:
 `POST /api/posts  PostController       ↓ PostService       ↓ PostRepository       ↓ Supabase PostgreSQL ` 
Business rule controller-এ ছড়িয়ে থাকবে না।
  
# 6. Authentication architecture
 
### Login
 
Existing Supabase Auth থাকবে।
 
Flutter:
 `Supabase Auth    ↓ access token ` 
তারপর backend API:
 `Authorization: Bearer <access_token> ` 
Backend:
 `JWT verification       ↓ user_id       ↓ request context ` 
প্রতিটা request-এ backend জানবে:
 `user_id active_profile_id session info role/permissions where needed ` 
### Important
 
Backend কখনো frontend থেকে শুধু:
 `user_id=123 ` 
পেয়ে trust করবে না।
 
JWT থেকে authenticated user resolve করবে।
  
# 7. Active Profile
 
তোমাদের multi-profile system-এর কারণে প্রতিটি request-এ active profile context গুরুত্বপূর্ণ।
 
যেমন header:
 `Authorization: Bearer ... X-Active-Profile-Id: ... ` 
কিন্তু backend শুধু header trust করবে না।
 
Backend check করবে:
 `Is this profile owned by this account? Is this team profile accessible to this member? What permissions does this active profile have? ` 
এতে user Team A active করে Team B-এর data access করতে পারবে না।
  
# 8. Authorization model
 
Backend authorization তিন স্তরের হবে:
 
### Layer 1 — Authenticated user
 
JWT valid?
 
### Layer 2 — Profile ownership/access
 
User কি profile-এর owner/member?
 
### Layer 3 — Action permission
 
এই action-এর permission আছে?
 
উদাহরণ:
 `POST /teams/:teamId/admins ` 
Backend check করবে:
 `authenticated → belongs to team → role = owner → recent reauth required → perform action ` 
তারপর DB/RLS আবার enforce করবে।
  
# 9. Database access
 
Backend Supabase-এর সাথে দুইভাবে কাজ করবে:
 
### User-scoped operation
 
RLS-aware user context ব্যবহার করা preferable।
 
### Privileged backend operation
 
শুধু trusted server environment-এ Supabase server-side credential ব্যবহার করা যাবে।
 
কিন্তু business code-এ সব জায়গায় elevated client ব্যবহার করবে না।
 
Rule:
 
 
**Default = least privilege**
 
  
# 10. Environment Variables
 
এগুলো **development `.env` এবং Vercel Environment Variables**-এ থাকবে।
 
## Supabase
 `SUPABASE_URL= SUPABASE_ANON_KEY= SUPABASE_SERVICE_ROLE_KEY= ` 
`SUPABASE_SERVICE_ROLE_KEY`:
 
**শুধু backend server-side। Flutter-এ কখনো নয়।**
  
## Backend
 `NODE_ENV=production PORT= API_BASE_URL= APP_ORIGIN= `  
## Cloudflare R2
 `R2_ACCOUNT_ID= R2_ACCESS_KEY_ID= R2_SECRET_ACCESS_KEY= R2_BUCKET= R2_PUBLIC_BASE_URL= ` 
যদি আলাদা bucket ব্যবহার করো:
 `R2_PROFILE_BUCKET= R2_POST_BUCKET= ` 
তবে শুরুতে single bucket + logical prefixes যথেষ্ট।
  
## Cloudflare Stream
 `CLOUDFLARE_ACCOUNT_ID= CLOUDFLARE_STREAM_API_TOKEN= CLOUDFLARE_STREAM_WEBHOOK_SECRET= ` 
`STREAM_WEBHOOK_SECRET` backend-এ incoming webhook verify করার জন্য।
  
## Firebase / FCM
 
তোমাদের existing Firebase service account credentials-এর equivalent secure backend vars:
 `FIREBASE_PROJECT_ID= FIREBASE_CLIENT_EMAIL= FIREBASE_PRIVATE_KEY= ` 
Private key formatting carefully handle করতে হবে।
  
## Gmail SMTP
 `SMTP_HOST=smtp.gmail.com SMTP_PORT=465 SMTP_USERNAME= SMTP_PASSWORD= SMTP_FROM_EMAIL= ` 
`SMTP_PASSWORD` = **Gmail App Password**, normal Gmail password নয়।
  
## Security
 
প্রয়োজন অনুযায়ী:
 `JWT_ISSUER= JWT_AUDIENCE= ENCRYPTION_KEY= INTERNAL_WEBHOOK_SECRET= ` 
যেখানে প্রয়োজন নেই সেখানে secret তৈরি করা যাবে না।
  
# 11. R2 image architecture
 
সব নতুন image:
 `Profile avatar Team avatar Cover/banner Post images Multi-image posts Support attachments if applicable ` 
→ **R2**
 
Upload flow:
 `Flutter  ↓ POST /api/media/images/upload-session  ↓ Backend auth + validation  ↓ R2 presigned upload  ↓ Flutter → R2  ↓ POST /api/media/images/complete  ↓ Backend validates metadata  ↓ Supabase media metadata ` 
Backend actual image bytes proxy করবে না।
  
# 12. R2 validation
 
Backend check করবে:
 
 
- authenticated user
 
- profile ownership
 
- file type
 
- allowed MIME
 
- size limit
 
- path/prefix
 
- extension
 
- upload context
 

 
যেমন:
 `profiles/{profileId}/avatar/ profiles/{profileId}/cover/ posts/{postId}/ ` 
এতে storage organization clean থাকবে।
  
# 13. Cloudflare Stream architecture
 
Videos:
 
 
- Post video
 
- Shorts
 

 
Flow:
 `Flutter  ↓ POST /api/media/videos/upload-session  ↓ Backend  ↓ Cloudflare Stream Direct Creator Upload  ↓ one-time upload URL  ↓ Flutter → Stream  ↓ Stream:  storage  encoding  transcoding  adaptive bitrate  delivery  ↓ webhook  ↓ Backend  ↓ Supabase media row = ready ` 
Backend নিজে FFmpeg চালাবে না।
  
# 14. Stream media state
 
Database existing media system-এর সাথে minimal metadata integrate করবে:
 `provider = stream provider_uid = <UID> status = uploading | processing | ready | failed | deleted duration width height thumbnail_reference created_at ` 
Stream UID হবে canonical reference।
 
DB-তে permanent `.m3u8` URL source of truth হিসেবে রাখার দরকার নেই।
  
# 15. Stream webhook
 
Backend route:
 `POST /api/webhooks/cloudflare/stream ` 
Webhook verify করবে:
 `signature secret event integrity ` 
তারপর:
 `processing → ready ` 
অথবা:
 `processing → failed `  
# 16. Playback
 
Flutter backend থেকে metadata পাবে:
 `provider_uid status=ready ` 
তারপর playback URL/manifest resolve করবে।
 
যেমন HLS.
 
Backend video bytes stream করবে না।
  
# 17. Media deletion
 
Post delete:
 `Backend  ↓ authorization  ↓ DB soft/delete operation  ↓ identify attached media  ↓ R2 delete / Stream delete  ↓ media record cleanup  ↓ notification/search/feed cleanup if needed ` 
Failed storage deletion যেন silently হারিয়ে না যায়।
 
`media_cleanup` tracking রাখবে।
  
# 18. Posts API
 
Examples:
 `GET    /api/posts/feed GET    /api/posts/:id POST   /api/posts PATCH  /api/posts/:id DELETE /api/posts/:id ` 
Backend handles:
 
 
- active profile
 
- post ownership
 
- team permission
 
- attachments
 
- hashtags
 
- mentions
 
- visibility
 
- edit windows
 
- moderation
 
- notifications
 

  
# 19. Reaction API
 `POST   /api/posts/:id/reaction DELETE /api/posts/:id/reaction  POST   /api/comments/:id/reaction DELETE /api/comments/:id/reaction  GET /api/posts/:id/reactions GET /api/comments/:id/reactions ` 
Backend ensures one user/profile has one active reaction per target.
  
# 20. Team APIs
 `GET    /api/teams/:id PATCH  /api/teams/:id POST   /api/teams/:id/members DELETE /api/teams/:id/members/:memberId POST   /api/teams/:id/admins DELETE /api/teams/:id/admins/:adminId POST   /api/teams/:id/transfer-owner ` 
Sensitive routes:
 `owner-only recent-auth required audit log required `  
# 21. Recruitment/Application APIs
 `GET  /api/recruitments POST /api/recruitments PATCH /api/recruitments/:id POST /api/recruitments/:id/close  POST /api/applications GET  /api/applications/:id POST /api/applications/:id/tryout POST /api/applications/:id/accept POST /api/applications/:id/reject ` 
Backend validates:
 
 
- blocked profiles
 
- team permissions
 
- recruitment status
 
- roster conflict
 
- owner/admin role
 
- application state machine
 

  
# 22. Notification backend
 
Existing notification behavior থাকবে।
 
Flutter → backend:
 `POST /api/notifications/... ` 
Backend:
 `database notification ↓ existing notification tables/triggers ↓ push pipeline ` 
FCM sending backend-এ migrate হবে।
 
Existing notification data structure unnecessary change করা যাবে না।
  
# 23. Security email
 
Existing security email Edge Function logic migrate হবে:
 `POST /api/security/recovery-email/send POST /api/security/recovery-email/verify POST /api/security/new-login-alert ` 
Gmail SMTP backend করবে।
 
OTP:
 `secure random hash expiry attempt limit rate limit ` 
DB source of truth থাকবে।
  
# 24. Existing Edge Functions migration plan
 
Screenshot-এর functionsগুলো একসাথে cutover করা যাবে না।
 
প্রথমে তাদের behavior document করবে।
 
### `media-upload`
 
→ NestJS MediaService
 
### `media-delete`
 
→ NestJS MediaService
 
### `media-replace`
 
→ NestJS MediaService
 
### `media-cleanup`
 
→ Backend cleanup workflow
 
### `post-delete`
 
→ PostService + MediaService
 
### `push-dispatch`
 
→ NotificationService + FCM Service
 
### `security-email`
 
→ SecurityService + GmailService
 
### `account-recovery`
 
→ Auth/SecurityService
 
### `media-*` functions
 
→ R2/Stream provider services
  
# 25. Do not delete Edge Functions immediately
 
Migration order:
 `Existing Edge Function         ↓ New Backend implementation         ↓ Test         ↓ Production shadow/controlled usage         ↓ Switch traffic         ↓ Verify         ↓ Only then deprecate Edge Function ` 
কারণ একসাথে সব remove করলে rollback difficult হবে।
  
# 26. Admin Panel
 
Core Admin later API-first হবে:
 `Core Admin    ↓ Dedicated Backend    ↓ Supabase ` 
Admin frontend direct DB access করবে না।
 
Engine Admin:
 `Engine Admin    ↓ Backend ` 
Analytics Admin:
 `Analytics Admin    ↓ Backend ` 
অর্থাৎ ভবিষ্যতে ৩টা admin app একই API ব্যবহার করবে।
  
# 27. Search API
 
Flutter:
 `GET /api/search?q=... GET /api/search/profiles GET /api/search/teams GET /api/search/posts ` 
Backend:
 `validation filtering pagination Supabase query response normalization ` 
Android/Web একই backend ব্যবহার করবে।
 
এটা তোমার existing Search inconsistency-এরও বড় সমাধান হবে—সব platform একই API result পাবে।
  
# 28. Realtime architecture
 
যেসব feature সত্যিকারের realtime দরকার:
 
 
- application messages
 
- notifications
 
- unread counters
 
- security approval
 
- relevant application state
 

 
এসবের জন্য existing Supabase Realtime রাখা যায়।
 
Backend API সব data access control করবে, আর realtime subscriptions-এর authorization design inspect করে রাখা হবে।
  
# 29. Analytics architecture — এখনই full implementation নয়
 
Backend শুরুতেই event ingestion endpoint ready রাখতে পারে:
 `POST /api/analytics/events ` 
পরে:
 `Flutter ↓ Backend ↓ analytics_events ` 
এরপর aggregation।
 
এতে future Analytics Admin ও Engine সহজ হবে।
  
# 30. API response standard
 
সব API একই response format follow করবে:
 `{   "success": true,   "data": {},   "error": null,   "meta": {} } ` 
Errors:
 `{   "success": false,   "data": null,   "error": {     "code": "RECRUITMENT_CLOSED",     "message": "This recruitment is closed."   } } ` 
Flutter side handling অনেক সহজ হবে।
  
# 31. API versioning
 
শুরু থেকেই:
 `/api/v1/ ` 
যেমন:
 `/api/v1/posts /api/v1/profiles /api/v1/teams ` 
পরে breaking changes করলে `/v2` তৈরি করা যাবে।
  
# 32. Rate limiting
 
Redis ছাড়া শুরুতে backend-level/basic DB-backed rate limiting রাখা যায়।
 
Priority:
 `login-related OTP password recovery post creation comments reactions follow applications hire notifications support tickets ` 
পরে Redis যোগ করা যাবে।
  
# 33. Logging
 
Backend-এ structured logging:
 `request_id user_id route status duration error_code timestamp ` 
কিন্তু:
 `password OTP access token refresh token FCM secret ` 
কখনো log করা যাবে না।
  
# 34. Health checks
 
Routes:
 `GET /health GET /health/db GET /health/storage GET /health/stream ` 
Vercel monitoring/debugging-এর জন্য useful।
  
# 35. Webhook security
 
Cloudflare Stream webhook:
 `signature verification ` 
Internal webhook:
 `INTERNAL_WEBHOOK_SECRET ` 
কখনো public unauthenticated endpoint রাখা যাবে না।
  
# 36. CORS
 
শুধু allowed origins:
 `https://esporta.app https://admin.esporta.app https://engine.admin.esporta.app https://analytics.admin.esporta.app ` 
Development:
 `http://localhost:... ` 
Production-এ wildcard `*` নয়।
  
# 37. Flutter migration plan
 
Backend stable হওয়ার আগে Flutter-এর major rewrite শুরু করবে না।
 
### Stage A
 
Backend তৈরি।
 
### Stage B
 
API contract final।
 
### Stage C
 
Flutter `ApiClient`:
 `ApiClient AuthInterceptor ErrorHandler TokenManager ` 
### Stage D
 
Repository migration:
 `PostRepository ProfileRepository TeamRepository NotificationRepository ApplicationRepository ` 
Direct Supabase query → API call।
 
### Stage E
 
Media migration:
 `Image upload → R2 Video upload → Stream ` 
### Stage F
 
Old direct Supabase application queries remove।
  
# 38. Flutter-এ কী থাকবে?
 
Flutter:
 
**UI + local state + navigation + device features**
 
যেমন:
 `camera gallery video playback push notification secure storage UI state ` 
Backend:
 
**business logic + database + storage orchestration**
  
# 39. Testing strategy
 
Backend production-এ যাওয়ার আগে:
 
### Unit tests
 
Services:
 
 
- auth
 
- permissions
 
- media
 
- posts
 
- applications
 
- notifications
 

 
### Integration tests
 `API → Supabase API → R2 API → Stream API → FCM API → Gmail ` 
### Security tests
 
 
- unauthorized API
 
- wrong user
 
- wrong profile
 
- wrong team
 
- admin escalation
 
- owner transfer
 
- deleted resource
 
- expired token
 
- blocked user
 
- closed recruitment
 

 
### Media tests
 
 
- image upload
 
- image delete
 
- video upload
 
- processing
 
- webhook
 
- ready
 
- failed
 
- delete
 

  
# 40. Deployment stages
 
Vercel environments:
 `Development Preview Production ` 
Supabase:
 `Existing production project ` 
প্রথমে:
 `Backend local ↓ Supabase test data ↓ R2 test prefix/bucket ↓ Stream development usage ↓ FCM test device ` 
তারপর:
 `Vercel Preview ↓ Flutter test ↓ Production `  
# 41. Vercel-specific rule
 
Backend-এ long-running process ধরে design করবে না।
 
মানে:
 `❌ permanent worker ❌ infinite loop ❌ internal cron daemon ❌ FFmpeg server ❌ long-running video processor ` 
কারণ media processing Cloudflare Stream করবে।
 
Webhook/API request short-lived থাকবে।
  
# 42. What should be built first?
 
আমি implementation order এভাবে lock করতাম:
 `PHASE 1 NestJS foundation + config + logging + error handling + health + Supabase integration  PHASE 2 Auth verification + user/profile context + RLS-compatible DB access  PHASE 3 Profiles Teams Posts Comments Reactions Follows  PHASE 4 Recruitment Applications Tryouts Notifications Security  PHASE 5 R2 image service  PHASE 6 Cloudflare Stream + webhook + video lifecycle  PHASE 7 FCM + Gmail  PHASE 8 Admin APIs  PHASE 9 Analytics event ingestion  PHASE 10 Flutter migration `  
# 43. Final “done” state
 
Backend complete হলে:
 `Flutter      ↓ Dedicated API      ↓ ┌───────────────────────────────────┐ │           NestJS Backend          │ │                                   │ │ Auth verification                 │ │ Profiles                          │ │ Teams                             │ │ Posts                             │ │ Comments                          │ │ Reactions                         │ │ Recruitment                       │ │ Applications                      │ │ Notifications                     │ │ Security                          │ │ Analytics ingestion               │ │ Media orchestration               │ │ R2                                │ │ Stream                            │ │ FCM                               │ │ Gmail                             │ └───────────────┬───────────────────┘                 │         ┌───────┼──────────┐         ▼       ▼          ▼     Supabase    R2       Stream ` 
### Environment variable master list
 `NODE_ENV PORT API_BASE_URL APP_ORIGIN  SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY  R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET R2_PUBLIC_BASE_URL  CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_STREAM_API_TOKEN CLOUDFLARE_STREAM_WEBHOOK_SECRET  FIREBASE_PROJECT_ID FIREBASE_CLIENT_EMAIL FIREBASE_PRIVATE_KEY  SMTP_HOST SMTP_PORT SMTP_USERNAME SMTP_PASSWORD SMTP_FROM_EMAIL  INTERNAL_WEBHOOK_SECRET ENCRYPTION_KEY ` 
প্রতিটা variable **যেটা যে service ব্যবহার করে শুধু সেই server-side module access করবে**। `.env.example`-এ শুধু names থাকবে, actual secrets থাকবে না।
