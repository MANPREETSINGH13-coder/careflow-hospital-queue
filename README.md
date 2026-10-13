# CareFlow

## Data Detective

Data Detective is an authenticated workspace for Super Admins, Hospital Admins, and doctors at `/data-detective`. It accepts CSVs up to 1.5 MB, streams analysis progress, runs Python in an OpenAI-hosted sandbox, supports follow-up questions in the same session, renders generated charts, and downloads a Markdown findings report. A sample growth dataset is included.

For local standalone development, set `OPENAI_API_KEY` in the server environment and run `npm run data-detective` (defaults to `http://localhost:3001` and binds to loopback only). In hosted CareFlow, the feature uses MongoDB-backed sessions and permits only Super Admin, Hospital Admin, and doctor roles. Set the API key privately in `.env` or Render; never put it in browser code. Use `DATA_DETECTIVE_MODEL` to override the configured model.

CSV contents and questions are sent to OpenAI after the user confirms upload in the interface. Do not upload patient identifiers or data you are not authorized to share. The hosted Python sandbox is configured with outbound network access disabled. The standalone local server uses an in-memory session store, so sessions reset if it restarts; the hosted route uses the MongoDB-backed CareFlow session store.

CareFlow is a Node.js and Express hospital appointment and crowd management application, backed by MongoDB Atlas. It includes password based accounts, hospital scoped roles, one time invitations, appointment requests, queue tokens, check in, walk ins, queue operations, and basic wait estimates.

## Account rules

- Public signup creates patient accounts only.
- The configured initial Super Admin creates hospitals and invites Hospital Admins.
- Hospital Admins invite doctors, nurses, and reception staff for their own hospital.
- Invitees choose their own password using a single use token that expires in 48 hours.
- There is no email delivery configured. The invite token is returned once by the API; share it privately.

## Run locally

Requirements: Node.js 20+ and a MongoDB Atlas cluster or MongoDB replica set. Copy `.env.example` to `.env`, provide `MONGODB_URI`, a random `SESSION_SECRET` of at least 32 characters, and the initial Super Admin name, email, and unique password (at least 12 characters). Install with `npm install`, then run `npm start` and open `http://localhost:3000`.

The service creates MongoDB indexes and creates the initial Super Admin on first startup. It does not replace an existing Super Admin password. Transactions require a replica set; MongoDB Atlas supports this configuration.

## Deploy on Render

`render.yaml` defines the Node web service and `/api/health` check. Set `MONGODB_URI` to the Atlas connection string, `MONGODB_DB` (or existing `MONGODB_DATABASE`) to `careflow`, and provide `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` in the Render service environment. Render generates `SESSION_SECRET` from the Blueprint. Keep database credentials and admin passwords out of source control. Atlas Network Access must allow the Render service to reach the cluster; use the narrowest practical network rule.

Render web services bind to `0.0.0.0` and the supplied `PORT`. See the [Blueprint reference](https://render.com/docs/blueprint-spec), [web service guide](https://render.com/docs/web-services), and [environment variable guide](https://render.com/docs/configure-environment-variables).

## Security and privacy

- Passwords are stored as salted scrypt hashes and compared with a timing-safe comparison. Passwords must be at least 12 characters. Login, signup, invitations, general APIs, and Data Detective analysis have rate limits.
- Authentication uses an eight-hour MongoDB-backed session. The session cookie is HttpOnly, SameSite=Lax, and Secure in production. Session secrets, Atlas credentials, admin passwords, and the OpenAI API key are environment variables; `.env` files are ignored by Git.
- Server-side route guards enforce role permissions and hospital scoping. Patient routes return the signed-in patient's own records; doctors see assigned appointments. Invitations use random single-use tokens, store only a SHA-256 digest, and expire after 48 hours.
- Helmet sets browser security headers and a Content Security Policy. Mutating requests with an Origin header are restricted to the same host. JSON request bodies are size limited; uploaded CSV files are limited to 1.5 MB and the filename is sanitized.
- Data Detective is available only to Super Admin, Hospital Admin, and doctor accounts. Its API key stays on the server. A consent checkbox explains that uploaded CSV contents and questions are sent to OpenAI; the hosted Python sandbox has outbound network access disabled. Remove patient identifiers and only share data you are authorized to share.
- CareFlow voice announcements use the browser's built-in speech synthesis on the patient's device; there is no external text-to-speech API key involved.

These controls do not make the application HIPAA certified or establish compliance with local health-data rules. Do not use real patient data until the deployment, privacy/legal requirements, backup/retention settings, and operational safeguards have been independently reviewed. The current Content Security Policy allows inline scripts and styles for the existing frontend, which is a hardening opportunity.

## API overview

Authentication, authorization, validation, request rate limits, unique indexes, and hospital scoping are enforced by the API.

| Method | Route | Access |
| --- | --- | --- |
| `POST` | `/api/auth/register/patient` | Public patient signup (`name`, `email`, `phone`, `password`) |
| `POST` | `/api/auth/login` | Public login (`email`, `password`) |
| `POST` | `/api/auth/logout` | Signed in user |
| `GET` | `/api/me` | Signed in user |
| `POST` | `/api/auth/accept-invitation` | Public one time invitation (`token`, `password`) |
| `POST` | `/api/super-admin/hospital-invitations` | Super Admin; creates hospital and Hospital Admin invitation |
| `GET` | `/api/super-admin/hospitals` | Super Admin facility summaries |
| `GET` | `/api/super-admin/hospital-admins` | Super Admin; registered hospital admin accounts |
| `GET` | `/api/super-admin/overview` | Super Admin district summaries |
| `POST` | `/api/hospital/staff-invitations` | Hospital Admin; invite a doctor, nurse, or receptionist |
| `GET` | `/api/hospital/staff` | Hospital Admin, own facility |
| `GET` / `POST` | `/api/hospital/departments` | Hospital staff read; Hospital Admin creates |
| `GET` | `/api/hospital/dashboard` | Hospital Admin, nurse, or reception, own facility |
| `GET` | `/api/hospital/appointments` | Hospital Admin, nurse, or reception, own facility |
| `GET` | `/api/doctor/appointments` | Doctor, assigned appointments |
| `POST` | `/api/doctor/appointments/:id/actions` | Assigned doctor; approve, reject, start, complete, skip |
| `POST` / `GET` | `/api/patient/appointments` | Patient creates and views own appointments |
| `POST` | `/api/patient/appointments/:id/cancel` | Owning patient, before consultation starts |
| `POST` | `/api/patient/appointments/:id/check-in` | Owning patient with an approved visit scheduled today |
| `POST` | `/api/reception/walk-ins` | Hospital Admin or reception, own facility |
| `GET` | `/api/hospital/queue` | Hospital staff, own facility; doctors see assigned queue |
| `POST` | `/api/hospital/queue/call-next` | Hospital Admin or reception |
| `GET` | `/api/hospitals` and `/api/hospitals/:hospitalId/providers` | Public active facility/provider discovery |
| `GET` / `POST` | `/api/data-detective/*` | Signed-in Super Admin, Hospital Admin, or doctor; AI-assisted CSV analysis |
| `GET` | `/api/health` | Public service and database health |

Queue estimates use people ahead and the doctor's recorded average consultation time (12 minutes until enough visits are completed). Queue tokens are allocated transactionally. Patient queue information refreshes every 5 seconds while the dashboard is open; other signed-in dashboards refresh every 30 seconds.

The patient dashboard also includes an optional Hindi voice queue assistant. Patients can request a spoken ETA or opt into an alert when they are within a selected 5, 10, or 15 minute threshold, and a spoken notice when staff call their turn. Speech uses the browser's built-in speech synthesis on the patient's device; it is not a generative AI model, requires the page to remain open, and may depend on Hindi voice support in the browser. Voice preference is stored in that browser's local storage. Use headphones in shared spaces. Wait times are estimates and can change as the queue moves.

## Current frontend scope

The CareFlow landing page has separate Patient and Admin & Staff login buttons, patient self-registration, invitation acceptance, and a live hospital directory. Patient appointments, provider booking requests, check-in and cancellation; doctor appointment review and consultation actions; hospital queue and dashboard views; and Super Admin facility and administrator views now use the API and MongoDB. Patient queue data refreshes every 5 seconds; other dashboards refresh every 30 seconds. Hospital Admin and reception walk-ins create database queue records, and Super Admin/Hospital Admin invitation forms create single-use invitations.

For production, confirm Render has the required environment variables and `/api/health` returns a connected database status. The Blueprint intentionally leaves database credentials, admin credentials, and the OpenAI API key unsynced so they must be configured privately in Render. Do not open `index.html` as a `file://` page; use the Render service or run the Express server locally so same-origin API and session cookies work.

No email/SMS delivery, ABHA integration, document upload, medical record storage, or clinical decision support is included.
