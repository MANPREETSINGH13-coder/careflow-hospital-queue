'use strict';

require('dotenv').config();
const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient, ObjectId } = require('mongodb');
const { rateLimit } = require('express-rate-limit');

const scrypt = promisify(crypto.scrypt);
const app = express();
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || '';
if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');

const mongoClient = new MongoClient(process.env.MONGODB_URI, {
  appName: 'CareFlow',
  maxPoolSize: 20,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 10_000
});
let db;
const collections = {};

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
      baseUri: ["'self'"], frameAncestors: ["'none'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(express.json({ limit: '32kb', strict: true }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin request blocked.' });
      } catch { return res.status(403).json({ error: 'Invalid request origin.' }); }
    }
  }
  next();
});

const sessionStore = MongoStore.create({
  client: mongoClient,
  dbName: process.env.MONGODB_DB || process.env.MONGODB_DATABASE || 'careflow',
  collectionName: 'sessions',
  ttl: 8 * 60 * 60,
  autoRemove: 'native'
});
app.use(session({
  name: 'careflow.sid', secret: sessionSecret, store: sessionStore,
  resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, secure: production, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, path: '/' }
}));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const inviteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const fail = (status, message) => Object.assign(new Error(message), { status });
const clean = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const emailOf = value => clean(value, 254).toLowerCase();
const emailOK = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const passwordOK = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;
const idOf = value => {
  const raw = clean(value, 30);
  if (!ObjectId.isValid(raw) || String(new ObjectId(raw)) !== raw) throw fail(400, 'Invalid identifier.');
  return new ObjectId(raw);
};
const serviceDate = value => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const passwordHash = async value => {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(value, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${derived.toString('hex')}`;
};
const passwordMatches = async (value, stored) => {
  try {
    const [kind, n, r, p, salt, hash] = stored.split('$');
    if (kind !== 'scrypt' || !/^[\da-f]{32}$/i.test(salt) || !/^[\da-f]{128}$/i.test(hash)) return false;
    const actual = await scrypt(value, Buffer.from(salt, 'hex'), 64, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
  } catch { return false; }
};
const newToken = () => crypto.randomBytes(32).toString('base64url');
const tokenDigest = token => crypto.createHash('sha256').update(token).digest('hex');
const safeUser = user => ({
  id: String(user._id), name: user.fullName, email: user.email, phone: user.phone || null,
  role: user.role, hospitalId: user.hospitalId ? String(user.hospitalId) : null,
  hospitalName: user.hospitalName || null, departmentId: user.departmentId ? String(user.departmentId) : null,
  departmentName: user.departmentName || null
});
const loginAttempts = loginLimiter;

async function transaction(work) {
  return mongoClient.withSession(session => session.withTransaction(() => work(session), {
    readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }
  }));
}

async function loadUser(userId) {
  const user = await collections.users.findOne({ _id: idOf(userId), active: true });
  if (!user) return null;
  const hospital = user.hospitalId ? await collections.hospitals.findOne({ _id: user.hospitalId }) : null;
  const department = user.departmentId ? await collections.departments.findOne({ _id: user.departmentId }) : null;
  return { ...user, hospitalName: hospital?.name || null, departmentName: department?.name || null, hospitalStatus: hospital?.status || null };
}

async function requireAuth(req, res, next) {
  try {
    if (!req.session.userId) return res.status(401).json({ error: 'Login required.' });
    req.user = await loadUser(req.session.userId);
    if (!req.user) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Account is unavailable. Please sign in again.' });
    }
    if (req.user.hospitalId && req.user.hospitalStatus !== 'active' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'This hospital account is currently paused.' });
    }
    next();
  } catch (error) { next(error); }
}

function allowRoles(...roles) {
  return (req, res, next) => roles.includes(req.user?.role)
    ? next() : res.status(403).json({ error: 'You do not have access to this action.' });
}

function requireHospital(req, res, next) {
  if (!req.user.hospitalId) return res.status(403).json({ error: 'This account is not assigned to a hospital.' });
  next();
}

async function addQueueEvent(appointmentId, actorId, eventType, details = {}, session) {
  await collections.queueEvents.insertOne({ appointmentId, actorId: actorId || null, eventType, details, createdAt: new Date() }, { session });
}

async function allocateToken(hospitalId, departmentId, slotAt, session) {
  const day = serviceDate(slotAt);
  const department = await collections.departments.findOne({ _id: departmentId, hospitalId, active: true }, { session });
  if (!department) throw fail(404, 'Department not found.');
  const counter = await collections.queueCounters.findOneAndUpdate(
    { hospitalId, departmentId, serviceDate: day },
    { $inc: { lastNumber: 1 }, $setOnInsert: { hospitalId, departmentId, serviceDate: day, createdAt: new Date() } },
    { upsert: true, returnDocument: 'after', session }
  );
  const number = counter.lastNumber;
  return { day, number, label: `${department.code}-${String(number).padStart(3, '0')}` };
}

function patientView(appointment, patient, hospital, department, doctor, peopleAhead = 0, averageSeconds = 720) {
  return {
    id: String(appointment._id), appointmentStatus: appointment.appointmentStatus,
    queueStatus: appointment.queueStatus, slotAt: appointment.slotAt,
    serviceDate: appointment.serviceDate, token: appointment.tokenLabel || null,
    priority: appointment.priority, checkedInAt: appointment.checkedInAt || null,
    calledAt: appointment.calledAt || null, startedAt: appointment.startedAt || null,
    completedAt: appointment.completedAt || null, patientName: patient?.fullName || null,
    phone: patient?.phone || null, hospitalId: String(hospital._id), hospital: hospital.name,
    departmentId: String(department._id), department: department.name,
    doctorId: String(doctor._id), doctor: doctor.fullName,
    peopleAhead, estimatedWaitMinutes: appointment.tokenNumber == null ? null : Math.max(0, Math.ceil(peopleAhead * averageSeconds / 60))
  };
}

app.get('/api/health', async (_req, res) => {
  try { await db.command({ ping: 1 }); res.json({ status: 'ok', database: 'connected' }); }
  catch { res.status(503).json({ status: 'unavailable', database: 'disconnected' }); }
});

app.post('/api/auth/register/patient', loginAttempts, async (req, res, next) => {
  try {
    const fullName = clean(req.body.name, 120);
    const email = emailOf(req.body.email);
    const phone = clean(req.body.phone, 32) || null;
    const password = req.body.password;
    if (fullName.length < 2 || !emailOK(email) || !passwordOK(password)) throw fail(400, 'Enter a valid name and email, and a password of at least 12 characters.');
    const user = { fullName, email, phone, role: 'patient', hospitalId: null, departmentId: null, passwordHash: await passwordHash(password), active: true, createdAt: new Date() };
    const profile = { userId: null, fullName, phone, createdAt: new Date() };
    let patientUserId;
    await transaction(async session => {
      const inserted = await collections.users.insertOne(user, { session });
      patientUserId = inserted.insertedId;
      profile.userId = inserted.insertedId;
      await collections.patientProfiles.insertOne(profile, { session });
    });
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.userId = String(patientUserId);
      req.session.save(saveError => saveError ? next(saveError) : res.status(201).json({ user: safeUser({ ...user, _id: patientUserId }) }));
    });
  } catch (error) { next(error.code === 11000 ? fail(409, 'An account with this email already exists.') : error); }
});

app.post('/api/auth/login', loginAttempts, async (req, res, next) => {
  try {
    const email = emailOf(req.body.email);
    const password = req.body.password;
    const portal = req.body.portal;
    if (!['patient', 'admin'].includes(portal)) throw fail(400, 'Choose Patient login or Admin & staff login.');
    if (!emailOK(email) || typeof password !== 'string' || password.length > 128) throw fail(400, 'Enter your email and password.');
    const user = await collections.users.findOne({ email, active: true });
    const valid = user ? await passwordMatches(password, user.passwordHash) : false;
    if (!valid) return res.status(401).json({ error: 'Email or password is incorrect.' });
    if (portal === 'patient' && user.role !== 'patient') throw fail(403, 'This is the Patient login. Please use Admin & staff login for this account.');
    if (portal === 'admin' && user.role === 'patient') throw fail(403, 'This is a patient account. Please use Patient login.');
    const expanded = await loadUser(String(user._id));
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.userId = String(user._id);
      req.session.save(saveError => saveError ? next(saveError) : res.json({ user: safeUser(expanded) }));
    });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', requireAuth, (req, res, next) => {
  req.session.destroy(error => {
    if (error) return next(error);
    res.clearCookie('careflow.sid', { httpOnly: true, secure: production, sameSite: 'lax', path: '/' });
    res.status(204).end();
  });
});

app.get('/api/me', requireAuth, (_req, res) => res.json({ user: safeUser(_req.user) }));

app.post('/api/auth/accept-invitation', loginAttempts, async (req, res, next) => {
  try {
    const token = clean(req.body.token, 200);
    const password = req.body.password;
    if (token.length < 32 || !passwordOK(password)) throw fail(400, 'Use a valid invitation and a password of at least 12 characters.');
    let created;
    await transaction(async session => {
      const invite = await collections.invitations.findOne({ tokenHash: tokenDigest(token), acceptedAt: null, expiresAt: { $gt: new Date() } }, { session });
      if (!invite) throw fail(400, 'This invitation is invalid, expired, or already used.');
      const user = {
        fullName: invite.fullName, email: invite.email, phone: null, role: invite.role,
        hospitalId: invite.hospitalId, departmentId: invite.departmentId || null,
        passwordHash: await passwordHash(password), active: true, createdAt: new Date()
      };
      const result = await collections.users.insertOne(user, { session });
      user._id = result.insertedId;
      await collections.invitations.updateOne({ _id: invite._id, acceptedAt: null }, { $set: { acceptedAt: new Date() } }, { session });
      created = user;
    });
    const expanded = await loadUser(String(created._id));
    req.session.regenerate(error => {
      if (error) return next(error);
      req.session.userId = String(created._id);
      req.session.save(saveError => saveError ? next(saveError) : res.status(201).json({ user: safeUser(expanded) }));
    });
  } catch (error) { next(error.code === 11000 ? fail(409, 'An account with this email already exists.') : error); }
});

app.get('/api/hospitals', async (_req, res, next) => {
  try {
    const hospitals = await collections.hospitals.aggregate([
      { $match: { status: 'active' } },
      { $lookup: { from: 'users', let: { hospitalId: '$_id' }, pipeline: [
        { $match: { $expr: { $and: [{ $eq: ['$hospitalId', '$$hospitalId'] }, { $eq: ['$role', 'doctor'] }, { $eq: ['$active', true] }] } } },
        { $count: 'count' }
      ], as: 'doctorCount' } },
      { $project: { name: 1, district: 1, address: 1, activeDoctors: { $ifNull: [{ $arrayElemAt: ['$doctorCount.count', 0] }, 0] } } },
      { $sort: { district: 1, name: 1 } }
    ]).toArray();
    res.json({ hospitals: hospitals.map(h => ({ ...h, id: String(h._id), _id: undefined })) });
  } catch (error) { next(error); }
});

app.get('/api/hospitals/:hospitalId/providers', async (req, res, next) => {
  try {
    const hospitalId = idOf(req.params.hospitalId);
    const hospital = await collections.hospitals.findOne({ _id: hospitalId, status: 'active' });
    if (!hospital) throw fail(404, 'Hospital not found.');
    const providers = await collections.users.aggregate([
      { $match: { hospitalId, role: 'doctor', active: true, departmentId: { $ne: null } } },
      { $lookup: { from: 'departments', localField: 'departmentId', foreignField: '_id', as: 'department' } },
      { $unwind: '$department' }, { $match: { 'department.active': true } },
      { $project: { _id: 1, name: '$fullName', departmentId: { $toString: '$department._id' }, department: '$department.name' } },
      { $sort: { department: 1, name: 1 } }
    ]).toArray();
    res.json({ providers: providers.map(p => ({ ...p, id: String(p._id), _id: undefined })) });
  } catch (error) { next(error); }
});

app.post('/api/super-admin/hospital-invitations', requireAuth, allowRoles('super_admin'), inviteLimiter, async (req, res, next) => {
  try {
    const name = clean(req.body.hospitalName, 160);
    const district = clean(req.body.district, 100) || 'Bareilly';
    const address = clean(req.body.address, 300) || null;
    const adminName = clean(req.body.adminName, 120);
    const adminEmail = emailOf(req.body.adminEmail);
    if (name.length < 2 || adminName.length < 2 || !emailOK(adminEmail)) throw fail(400, 'Hospital name, administrator name, and a valid administrator email are required.');
    const alreadyInvited = await collections.invitations.findOne({ email: adminEmail, acceptedAt: null, expiresAt: { $gt: new Date() } });
    if (alreadyInvited || await collections.users.findOne({ email: adminEmail })) throw fail(409, 'That email already has an account or active invitation.');
    const token = newToken();
    let hospital;
    await transaction(async session => {
      hospital = { name, district, address, status: 'active', createdAt: new Date(), createdBy: req.user._id };
      const result = await collections.hospitals.insertOne(hospital, { session });
      hospital._id = result.insertedId;
      const defaults = [['General Medicine', 'GM'], ['Pediatrics', 'PE'], ['Cardiology', 'CA'], ['Orthopedics', 'OR'], ['Dermatology', 'DE'], ['Diagnostics', 'DI']];
      await collections.departments.insertMany(defaults.map(([departmentName, code]) => ({ hospitalId: hospital._id, name: departmentName, code, active: true, createdAt: new Date() })), { session });
      await collections.invitations.insertOne({
        hospitalId: hospital._id, departmentId: null, email: adminEmail, fullName: adminName,
        role: 'hospital_admin', tokenHash: tokenDigest(token), invitedBy: req.user._id,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), acceptedAt: null, createdAt: new Date()
      }, { session });
    });
    res.status(201).json({ hospital: { id: String(hospital._id), name, district }, adminInvitation: { email: adminEmail, token, expiresInHours: 48 } });
  } catch (error) { next(error.code === 11000 ? fail(409, 'A hospital administrator with that email already exists.') : error); }
});

app.get('/api/super-admin/hospitals', requireAuth, allowRoles('super_admin'), async (_req, res, next) => {
  try {
    const hospitals = await collections.hospitals.find({}).sort({ name: 1 }).toArray();
    const result = await Promise.all(hospitals.map(async hospital => {
      const today = serviceDate(new Date());
      const [activeQueue, completedToday, activeDoctors] = await Promise.all([
        collections.appointments.countDocuments({ hospitalId: hospital._id, serviceDate: today, queueStatus: { $in: ['waiting', 'called', 'serving'] } }),
        collections.appointments.countDocuments({ hospitalId: hospital._id, serviceDate: today, appointmentStatus: 'completed' }),
        collections.users.countDocuments({ hospitalId: hospital._id, role: 'doctor', active: true })
      ]);
      return { id: String(hospital._id), name: hospital.name, district: hospital.district, status: hospital.status, activeQueue, completedToday, activeDoctors };
    }));
    res.json({ hospitals: result });
  } catch (error) { next(error); }
});

app.get('/api/super-admin/hospital-admins', requireAuth, allowRoles('super_admin'), async (_req, res, next) => {
  try {
    const admins = await collections.users.find({ role: 'hospital_admin' }, { projection: { passwordHash: 0 } }).sort({ fullName: 1 }).toArray();
    const result = await Promise.all(admins.map(async admin => {
      const hospital = admin.hospitalId ? await collections.hospitals.findOne({ _id: admin.hospitalId }, { projection: { name: 1 } }) : null;
      return { ...safeUser(admin), hospitalName: hospital?.name || null, active: admin.active };
    }));
    res.json({ hospitalAdmins: result });
  } catch (error) { next(error); }
});

app.get('/api/hospital/departments', requireAuth, requireHospital, allowRoles('hospital_admin', 'doctor', 'nurse', 'reception'), async (req, res, next) => {
  try {
    const departments = await collections.departments.find({ hospitalId: req.user.hospitalId }).sort({ name: 1 }).toArray();
    res.json({ departments: departments.map(d => ({ id: String(d._id), name: d.name, code: d.code, active: d.active })) });
  } catch (error) { next(error); }
});

app.post('/api/hospital/departments', requireAuth, requireHospital, allowRoles('hospital_admin'), async (req, res, next) => {
  try {
    const name = clean(req.body.name, 100), code = clean(req.body.code, 8).toUpperCase();
    if (name.length < 2 || !/^[A-Z0-9]{2,8}$/.test(code)) throw fail(400, 'Enter a department name and a 2–8 character code.');
    const department = { hospitalId: req.user.hospitalId, name, code, active: true, createdAt: new Date() };
    const result = await collections.departments.insertOne(department);
    res.status(201).json({ department: { id: String(result.insertedId), name, code, active: true } });
  } catch (error) { next(error.code === 11000 ? fail(409, 'That department name or code already exists at this hospital.') : error); }
});

app.post('/api/hospital/staff-invitations', requireAuth, requireHospital, allowRoles('hospital_admin'), inviteLimiter, async (req, res, next) => {
  try {
    const name = clean(req.body.name, 120), email = emailOf(req.body.email), role = clean(req.body.role, 30);
    const departmentId = req.body.departmentId ? idOf(req.body.departmentId) : null;
    if (name.length < 2 || !emailOK(email) || !['doctor', 'nurse', 'reception'].includes(role)) throw fail(400, 'Enter a valid staff name, email, and role.');
    if (role === 'doctor' && !departmentId) throw fail(400, 'Doctors must be assigned to a department.');
    if (departmentId && !await collections.departments.findOne({ _id: departmentId, hospitalId: req.user.hospitalId, active: true })) throw fail(400, 'Choose an active department at your hospital.');
    if (await collections.users.findOne({ email }) || await collections.invitations.findOne({ email, acceptedAt: null, expiresAt: { $gt: new Date() } })) throw fail(409, 'That email already has an account or active invitation.');
    const token = newToken();
    await collections.invitations.insertOne({
      hospitalId: req.user.hospitalId, departmentId, email, fullName: name, role,
      tokenHash: tokenDigest(token), invitedBy: req.user._id,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), acceptedAt: null, createdAt: new Date()
    });
    res.status(201).json({ invitation: { email, name, role, token, expiresInHours: 48 } });
  } catch (error) { next(error.code === 11000 ? fail(409, 'That email already has an account or invitation.') : error); }
});

app.get('/api/hospital/staff', requireAuth, requireHospital, allowRoles('hospital_admin'), async (req, res, next) => {
  try {
    const staff = await collections.users.find({ hospitalId: req.user.hospitalId, role: { $in: ['doctor', 'nurse', 'reception'] } }, { projection: { passwordHash: 0 } }).sort({ role: 1, fullName: 1 }).toArray();
    res.json({ staff: staff.map(u => ({ ...safeUser(u), active: u.active })) });
  } catch (error) { next(error); }
});

app.get('/api/hospital/appointments', requireAuth, requireHospital, allowRoles('hospital_admin', 'nurse', 'reception'), async (req, res, next) => {
  try {
    const allowed = ['requested', 'approved', 'rejected', 'cancelled', 'completed'];
    const status = clean(req.query.status, 20);
    const filter = { hospitalId: req.user.hospitalId };
    if (allowed.includes(status)) filter.appointmentStatus = status;
    const appointments = await collections.appointments.find(filter).sort({ slotAt: -1 }).limit(250).toArray();
    const result = await Promise.all(appointments.map(a => hydrateAppointment(a)));
    res.json({ appointments: result });
  } catch (error) { next(error); }
});

app.get('/api/doctor/appointments', requireAuth, allowRoles('doctor'), async (req, res, next) => {
  try {
    const appointments = await collections.appointments.find({ doctorId: req.user._id, slotAt: { $gte: new Date(Date.now() - 30 * 86400_000) } }).sort({ slotAt: 1 }).limit(250).toArray();
    res.json({ appointments: await Promise.all(appointments.map(a => hydrateAppointment(a))) });
  } catch (error) { next(error); }
});

async function hydrateAppointment(appointment) {
  const [patient, hospital, department, doctor] = await Promise.all([
    collections.patientProfiles.findOne({ _id: appointment.patientProfileId }),
    collections.hospitals.findOne({ _id: appointment.hospitalId }),
    collections.departments.findOne({ _id: appointment.departmentId }),
    collections.users.findOne({ _id: appointment.doctorId }, { projection: { fullName: 1 } })
  ]);
  return patientView(appointment, patient, hospital, department, doctor);
}

app.get('/api/hospital/dashboard', requireAuth, requireHospital, allowRoles('hospital_admin', 'nurse', 'reception'), async (req, res, next) => {
  try {
    const today = serviceDate(new Date()), base = { hospitalId: req.user.hospitalId, serviceDate: today };
    const [pendingApprovals, activeQueue, completedToday, waits] = await Promise.all([
      collections.appointments.countDocuments({ ...base, appointmentStatus: 'requested' }),
      collections.appointments.countDocuments({ ...base, queueStatus: { $in: ['waiting', 'called', 'serving'] } }),
      collections.appointments.countDocuments({ ...base, appointmentStatus: 'completed' }),
      collections.appointments.find({ ...base, queueStatus: 'waiting' }, { projection: { tokenNumber: 1, departmentId: 1 } }).toArray()
    ]);
    res.json({ metrics: { pendingApprovals, activeQueue, completedToday, waitingPatients: waits.length } });
  } catch (error) { next(error); }
});

app.post('/api/patient/appointments', requireAuth, allowRoles('patient'), async (req, res, next) => {
  try {
    const doctorId = idOf(req.body.providerId), departmentId = idOf(req.body.departmentId);
    const slotAt = new Date(req.body.slotAt);
    if (Number.isNaN(slotAt.getTime()) || slotAt <= new Date() || slotAt > new Date(Date.now() + 90 * 86400_000)) throw fail(400, 'Choose an appointment time within the next 90 days.');
    const profile = await collections.patientProfiles.findOne({ userId: req.user._id });
    if (!profile) throw fail(409, 'Patient profile is unavailable.');
    const doctor = await collections.users.findOne({ _id: doctorId, role: 'doctor', active: true, departmentId });
    if (!doctor || !await collections.hospitals.findOne({ _id: doctor.hospitalId, status: 'active' }) || !await collections.departments.findOne({ _id: departmentId, hospitalId: doctor.hospitalId, active: true })) throw fail(400, 'That doctor is not an active registered provider for the selected department.');
    const appointment = {
      hospitalId: doctor.hospitalId, departmentId, patientProfileId: profile._id, doctorId,
      appointmentStatus: 'requested', queueStatus: 'not_arrived', priority: 'normal', slotAt,
      serviceDate: serviceDate(slotAt), tokenNumber: null, tokenLabel: null,
      requestedAt: new Date(), createdBy: req.user._id, createdAt: new Date(), updatedAt: new Date()
    };
    const result = await collections.appointments.insertOne(appointment);
    await addQueueEvent(result.insertedId, req.user._id, 'appointment_requested');
    res.status(201).json({ appointment: { id: String(result.insertedId), appointmentStatus: appointment.appointmentStatus, queueStatus: appointment.queueStatus, slotAt, token: null } });
  } catch (error) { next(error); }
});

app.get('/api/patient/appointments', requireAuth, allowRoles('patient'), async (req, res, next) => {
  try {
    const profile = await collections.patientProfiles.findOne({ userId: req.user._id });
    if (!profile) return res.json({ appointments: [] });
    const items = await collections.appointments.find({ patientProfileId: profile._id }).sort({ slotAt: -1 }).limit(100).toArray();
    const appointments = await Promise.all(items.map(async a => {
      const ahead = a.tokenNumber == null ? 0 : await collections.appointments.countDocuments({
        hospitalId: a.hospitalId, departmentId: a.departmentId, serviceDate: a.serviceDate,
        tokenNumber: { $lt: a.tokenNumber }, queueStatus: { $in: ['waiting', 'called', 'serving'] }
      });
      const average = await collections.appointments.aggregate([
        { $match: { doctorId: a.doctorId, consultationSeconds: { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$consultationSeconds' } } }
      ]).next();
      const [hospital, department, doctor] = await Promise.all([
        collections.hospitals.findOne({ _id: a.hospitalId }),
        collections.departments.findOne({ _id: a.departmentId }),
        collections.users.findOne({ _id: a.doctorId }, { projection: { fullName: 1 } })
      ]);
      return patientView(a, profile, hospital, department, doctor, ahead, average?.avg || 720);
    }));
    res.json({ appointments });
  } catch (error) { next(error); }
});

app.post('/api/patient/appointments/:id/cancel', requireAuth, allowRoles('patient'), async (req, res, next) => {
  try {
    const profile = await collections.patientProfiles.findOne({ userId: req.user._id });
    const result = await collections.appointments.updateOne(
      { _id: idOf(req.params.id), patientProfileId: profile?._id, appointmentStatus: { $in: ['requested', 'approved'] }, queueStatus: { $in: ['not_arrived', 'waiting'] } },
      { $set: { appointmentStatus: 'cancelled', queueStatus: 'cancelled', updatedAt: new Date() } }
    );
    if (!result.modifiedCount) throw fail(409, 'This appointment cannot be cancelled. Contact the hospital if you need help.');
    await addQueueEvent(idOf(req.params.id), req.user._id, 'cancelled_by_patient');
    res.status(204).end();
  } catch (error) { next(error); }
});

app.post('/api/patient/appointments/:id/check-in', requireAuth, allowRoles('patient'), async (req, res, next) => {
  try {
    const profile = await collections.patientProfiles.findOne({ userId: req.user._id });
    const today = serviceDate(new Date());
    const result = await collections.appointments.updateOne(
      { _id: idOf(req.params.id), patientProfileId: profile?._id, appointmentStatus: 'approved', queueStatus: 'not_arrived', serviceDate: today },
      { $set: { queueStatus: 'waiting', checkedInAt: new Date(), updatedAt: new Date() } }
    );
    if (!result.modifiedCount) throw fail(409, 'Check-in is available only for an approved appointment scheduled today.');
    await addQueueEvent(idOf(req.params.id), req.user._id, 'patient_checked_in');
    res.json({ status: 'waiting' });
  } catch (error) { next(error); }
});

app.post('/api/reception/walk-ins', requireAuth, requireHospital, allowRoles('hospital_admin', 'reception'), async (req, res, next) => {
  try {
    const fullName = clean(req.body.name, 120), phone = clean(req.body.phone, 32) || null;
    const departmentId = idOf(req.body.departmentId), doctorId = idOf(req.body.doctorId);
    if (fullName.length < 2) throw fail(400, 'Patient name is required.');
    const doctor = await collections.users.findOne({ _id: doctorId, hospitalId: req.user.hospitalId, departmentId, role: 'doctor', active: true });
    if (!doctor) throw fail(400, 'Choose an active doctor from this department.');
    let created;
    await transaction(async session => {
      const patient = { userId: null, fullName, phone, createdAt: new Date() };
      const profileResult = await collections.patientProfiles.insertOne(patient, { session });
      const now = new Date(), token = await allocateToken(req.user.hospitalId, departmentId, now, session);
      const appointment = {
        hospitalId: req.user.hospitalId, departmentId, patientProfileId: profileResult.insertedId,
        doctorId, appointmentStatus: 'approved', queueStatus: 'waiting', priority: 'normal',
        slotAt: now, serviceDate: token.day, tokenNumber: token.number, tokenLabel: token.label,
        approvedAt: now, checkedInAt: now, createdBy: req.user._id, createdAt: now, updatedAt: now
      };
      const result = await collections.appointments.insertOne(appointment, { session });
      appointment._id = result.insertedId;
      await addQueueEvent(result.insertedId, req.user._id, 'walk_in_registered', {}, session);
      created = { id: String(result.insertedId), patientName: fullName, token: token.label, queueStatus: 'waiting' };
    });
    res.status(201).json({ appointment: created });
  } catch (error) { next(error); }
});

app.get('/api/hospital/queue', requireAuth, requireHospital, allowRoles('hospital_admin', 'doctor', 'nurse', 'reception'), async (req, res, next) => {
  try {
    const filter = {
      hospitalId: req.user.hospitalId,
      serviceDate: serviceDate(new Date()),
      queueStatus: { $nin: ['completed', 'cancelled', 'skipped'] }
    };
    if (req.user.role === 'doctor') filter.doctorId = req.user._id;
    if (req.query.departmentId) filter.departmentId = idOf(req.query.departmentId);
    const items = await collections.appointments.find(filter).sort({ priority: -1, tokenNumber: 1 }).limit(500).toArray();
    const queue = await Promise.all(items.map(async a => {
      const patient = await collections.patientProfiles.findOne({ _id: a.patientProfileId });
      const doctor = await collections.users.findOne({ _id: a.doctorId }, { projection: { fullName: 1 } });
      const department = await collections.departments.findOne({ _id: a.departmentId }, { projection: { name: 1 } });
      return { id: String(a._id), hospitalId: String(a.hospitalId), departmentId: String(a.departmentId), doctorId: String(a.doctorId), token: a.tokenLabel, tokenNumber: a.tokenNumber, appointmentStatus: a.appointmentStatus, queueStatus: a.queueStatus, slotAt: a.slotAt, priority: a.priority, patientName: patient?.fullName, phone: patient?.phone || null, department: department?.name, doctor: doctor?.fullName };
    }));
    res.json({ queue });
  } catch (error) { next(error); }
});

app.post('/api/hospital/queue/call-next', requireAuth, requireHospital, allowRoles('hospital_admin', 'reception'), async (req, res, next) => {
  try {
    const departmentId = idOf(req.body.departmentId), today = serviceDate(new Date());
    const next = await collections.appointments.findOneAndUpdate(
      { hospitalId: req.user.hospitalId, departmentId, serviceDate: today, queueStatus: 'waiting' },
      { $set: { queueStatus: 'called', calledAt: new Date(), updatedAt: new Date() } },
      { sort: { priority: -1, tokenNumber: 1 }, returnDocument: 'after' }
    );
    if (!next) throw fail(404, 'No checked-in patients are waiting in this department.');
    await addQueueEvent(next._id, req.user._id, 'patient_called');
    res.json({ appointment: { id: String(next._id), token: next.tokenLabel, queueStatus: next.queueStatus } });
  } catch (error) { next(error); }
});

app.post('/api/doctor/appointments/:id/actions', requireAuth, allowRoles('doctor'), async (req, res, next) => {
  try {
    const appointmentId = idOf(req.params.id), action = clean(req.body.action, 20);
    if (!['approve', 'reject', 'start', 'complete', 'skip'].includes(action)) throw fail(400, 'Unsupported appointment action.');
    let response;
    await transaction(async session => {
      const a = await collections.appointments.findOne({ _id: appointmentId, doctorId: req.user._id }, { session });
      if (!a) throw fail(404, 'Appointment not found for this doctor.');
      const now = new Date();
      if (action === 'approve') {
        if (a.appointmentStatus !== 'requested') throw fail(409, 'Only requested appointments can be approved.');
        const token = await allocateToken(a.hospitalId, a.departmentId, a.slotAt, session);
        await collections.appointments.updateOne({ _id: a._id }, { $set: { appointmentStatus: 'approved', queueStatus: 'not_arrived', approvedAt: now, serviceDate: token.day, tokenNumber: token.number, tokenLabel: token.label, updatedAt: now } }, { session });
        response = { id: String(a._id), appointmentStatus: 'approved', queueStatus: 'not_arrived', token: token.label };
      } else if (action === 'reject') {
        if (a.appointmentStatus !== 'requested') throw fail(409, 'Only requested appointments can be declined.');
        await collections.appointments.updateOne({ _id: a._id }, { $set: { appointmentStatus: 'rejected', queueStatus: 'cancelled', updatedAt: now } }, { session });
        response = { id: String(a._id), appointmentStatus: 'rejected', queueStatus: 'cancelled' };
      } else if (action === 'start') {
        if (a.appointmentStatus !== 'approved' || !['waiting', 'called'].includes(a.queueStatus)) throw fail(409, 'Only an approved patient in the active queue can start a consultation.');
        await collections.appointments.updateOne({ _id: a._id }, { $set: { queueStatus: 'serving', startedAt: now, updatedAt: now } }, { session });
        response = { id: String(a._id), appointmentStatus: a.appointmentStatus, queueStatus: 'serving', token: a.tokenLabel };
      } else if (action === 'complete') {
        if (a.queueStatus !== 'serving' || !a.startedAt) throw fail(409, 'Start the consultation before completing it.');
        const consultationSeconds = Math.max(0, Math.floor((now - a.startedAt) / 1000));
        await collections.appointments.updateOne({ _id: a._id }, { $set: { queueStatus: 'completed', appointmentStatus: 'completed', completedAt: now, consultationSeconds, updatedAt: now } }, { session });
        response = { id: String(a._id), appointmentStatus: 'completed', queueStatus: 'completed', token: a.tokenLabel };
      } else {
        if (!['waiting', 'called'].includes(a.queueStatus)) throw fail(409, 'Only a patient in the active queue can be skipped.');
        await collections.appointments.updateOne({ _id: a._id }, { $set: { queueStatus: 'skipped', updatedAt: now } }, { session });
        response = { id: String(a._id), appointmentStatus: a.appointmentStatus, queueStatus: 'skipped', token: a.tokenLabel };
      }
      await addQueueEvent(a._id, req.user._id, `doctor_${action}`, {}, session);
    });
    res.json({ appointment: response });
  } catch (error) { next(error); }
});

app.get('/api/super-admin/overview', requireAuth, allowRoles('super_admin'), async (_req, res, next) => {
  try {
    const hospitals = await collections.hospitals.find({}).sort({ name: 1 }).toArray();
    const today = serviceDate(new Date());
    const facilities = await Promise.all(hospitals.map(async h => {
      const [activeQueue, completedToday] = await Promise.all([
        collections.appointments.countDocuments({ hospitalId: h._id, serviceDate: today, queueStatus: { $in: ['waiting', 'called', 'serving'] } }),
        collections.appointments.countDocuments({ hospitalId: h._id, serviceDate: today, appointmentStatus: 'completed' })
      ]);
      return { id: String(h._id), name: h.name, district: h.district, status: h.status, activeQueue, completedToday };
    }));
    res.json({ facilities });
  } catch (error) { next(error); }
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(/^\/api\//, (_req, res) => res.status(404).json({ error: 'API route not found.' }));
app.use((req, res) => res.status(404).json({ error: 'Page not found.' }));
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  const status = Number(error.status) || (error.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error('CareFlow request failed:', error.message);
  res.status(status).json({ error: status >= 500 ? 'A server error occurred.' : error.message });
});

async function ensureIndexes() {
  await Promise.all([
    collections.users.createIndex({ email: 1 }, { unique: true }),
    collections.hospitals.createIndex({ district: 1, name: 1 }),
    collections.departments.createIndex({ hospitalId: 1, name: 1 }, { unique: true }),
    collections.departments.createIndex({ hospitalId: 1, code: 1 }, { unique: true }),
    collections.patientProfiles.createIndex({ userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }),
    collections.invitations.createIndex({ tokenHash: 1 }, { unique: true }),
    collections.invitations.createIndex({ email: 1, expiresAt: 1 }),
    collections.invitations.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { acceptedAt: { $eq: null } } }),
    collections.queueCounters.createIndex({ hospitalId: 1, departmentId: 1, serviceDate: 1 }, { unique: true }),
    collections.appointments.createIndex({ patientProfileId: 1, slotAt: -1 }),
    collections.appointments.createIndex({ doctorId: 1, slotAt: 1, appointmentStatus: 1 }),
    collections.appointments.createIndex({ hospitalId: 1, departmentId: 1, serviceDate: 1, queueStatus: 1, tokenNumber: 1 }),
    collections.appointments.createIndex({ hospitalId: 1, departmentId: 1, serviceDate: 1, tokenNumber: 1 }, { unique: true, partialFilterExpression: { tokenNumber: { $type: 'number' } } }),
    collections.queueEvents.createIndex({ appointmentId: 1, createdAt: 1 })
  ]);
}

async function bootstrapSuperAdmin() {
  const fullName = clean(process.env.SUPER_ADMIN_NAME, 120);
  const email = emailOf(process.env.SUPER_ADMIN_EMAIL);
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (fullName.length < 2 || !emailOK(email) || !passwordOK(password)) throw new Error('Set SUPER_ADMIN_NAME, SUPER_ADMIN_EMAIL, and SUPER_ADMIN_PASSWORD (12+ characters) before startup.');
  const existingSuper = await collections.users.findOne({ role: 'super_admin' }, { projection: { _id: 1 } });
  if (existingSuper) return;
  if (await collections.users.findOne({ email })) throw new Error('SUPER_ADMIN_EMAIL is already assigned to a non-Super Admin account.');
  await collections.users.insertOne({
    fullName, email, phone: null, role: 'super_admin', hospitalId: null, departmentId: null,
    passwordHash: await passwordHash(password), active: true, createdAt: new Date()
  });
}

async function start() {
  await mongoClient.connect();
  db = mongoClient.db(process.env.MONGODB_DB || process.env.MONGODB_DATABASE || 'careflow');
  for (const name of ['users', 'hospitals', 'departments', 'patientProfiles', 'invitations', 'queueCounters', 'appointments', 'queueEvents']) collections[name] = db.collection(name);
  await ensureIndexes();
  await bootstrapSuperAdmin();
  const server = app.listen(port, '0.0.0.0', () => console.log(`CareFlow listening on 0.0.0.0:${port}`));
  const shutdown = signal => {
    console.log(`${signal} received; closing CareFlow.`);
    server.close(() => mongoClient.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(error => {
  console.error('CareFlow startup failed:', error.message);
  process.exit(1);
});
