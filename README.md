# CareFlow

CareFlow is a Node.js and Express hospital appointment and crowd management starter, backed by MongoDB Atlas. It includes password based accounts, hospital scoped roles, one time invitations, appointment requests, queue tokens, check in, walk ins, queue operations, and basic wait estimates.

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

## API overview

Session cookies are HttpOnly, SameSite=Lax, and stored in MongoDB. Mutating browser requests are restricted to same-origin requests. Authentication, authorization, validation, request rate limits, unique indexes, and hospital scoping are enforced by the API.

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
| `GET` | `/api/health` | Public service and database health |

Queue estimates use the number of people ahead and the doctor's recorded average consultation time (12 minutes until enough visits are completed). Queue tokens are allocated transactionally. The patient dashboard reads appointments and live queue estimates from the API and refreshes them every 30 seconds while the dashboard is open.

The patient dashboard also includes an optional Hindi voice queue assistant. Patients can request a spoken ETA or opt into an alert when they are within a selected 5, 10, or 15 minute threshold, and a spoken notice when staff call their turn. Speech uses the browser's built-in speech synthesis on the patient's device; it is not a generative AI model, requires the page to remain open, and may depend on Hindi voice support in the browser. Voice preference is stored in that browser's local storage. Use headphones in shared spaces. Wait times are estimates and can change as the queue moves.

## Current frontend scope

The CareFlow landing page has separate Patient and Admin & Staff login buttons, patient self-registration, invitation acceptance, and a live hospital directory. Patient appointments, provider booking requests, check-in and cancellation; doctor appointment review and consultation actions; hospital queue and dashboard views; and Super Admin facility and administrator views now use the API and MongoDB. Dashboard data refreshes every 30 seconds while the user is signed in. Hospital Admin and reception walk-ins create database queue records, and Super Admin/Hospital Admin invitation forms create single-use invitations.

Render and Atlas still need their production environment variables and a successful `/api/health` response before this local code can be considered live. Do not open `index.html` as a `file://` page; use the Render service or run the Express server locally so same-origin API and session cookies work. Do not enter real patient information until production connection, frontend operations, security/privacy review, backups, and operational procedures are verified.

No email/SMS delivery, ABHA integration, document upload, medical record storage, or clinical decision support is included. This starter is not a healthcare compliance certification. Do not enter real patient information until frontend integration, security/privacy review, backups, and operational procedures are in place.
