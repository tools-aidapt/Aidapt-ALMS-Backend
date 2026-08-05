'use strict';

const { z } = require('zod');

const PHONE_RE = /^\+\d{1,4} \d{4,15}$/;
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .nullable();

function currentYear() {
  return new Date().getUTCFullYear();
}

/** Max birth date for age >= 14 (PKT calendar day is not required for this bound). */
function maxDateOfBirthIso() {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 14);
  return d.toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** ISO 13616 IBAN mod-97 check; returns false for empty/invalid shapes. */
function isValidIban(raw) {
  if (raw == null || raw === '') return true;
  const iban = String(raw).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.length < 15 || iban.length > 34) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let expanded = '';
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    expanded += code >= 65 && code <= 90 ? String(code - 55) : ch;
  }
  // iterative mod 97 for large numbers
  let remainder = 0;
  for (let i = 0; i < expanded.length; i += 1) {
    remainder = (remainder * 10 + Number(expanded[i])) % 97;
  }
  return remainder === 1;
}

function normalizeIban(raw) {
  if (raw == null || raw === '') return raw;
  return String(raw).replace(/\s+/g, '').toUpperCase();
}

const phoneSchema = z
  .string()
  .nullable()
  .optional()
  .refine((v) => v == null || v === '' || PHONE_RE.test(v), {
    message: 'must be "+<dial> <national>" with one space',
  });

const emergencyContactSchema = z.object({
  name: z.string().min(1),
  relationship: z.string().min(1),
  phone: z
    .string()
    .min(1)
    .refine((v) => PHONE_RE.test(v), {
      message: 'must be "+<dial> <national>" with one space',
    }),
});

const educationSchema = z.object({
  qualification: z.string().min(1),
  institution: z.string().min(1),
  year: z
    .number()
    .int()
    .nullable()
    .refine((y) => y == null || (y >= 1950 && y <= currentYear()), {
      message: `year must be between 1950 and ${currentYear()}`,
    }),
});

const experienceSchema = z
  .object({
    company: z.string().min(1),
    title: z.string().min(1),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
    toDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
      .nullable(),
    summary: z.string().optional().default(''),
  })
  .refine((row) => row.toDate == null || row.toDate >= row.fromDate, {
    message: 'toDate must be on or after fromDate',
    path: ['toDate'],
  });

const dateOfBirthSchema = dateStr.optional().refine(
  (v) => {
    if (v == null || v === undefined) return true;
    if (v > todayIso()) return false;
    if (v > maxDateOfBirthIso()) return false;
    return true;
  },
  { message: 'dateOfBirth must be in the past and imply age of at least 14' }
);

const ibanSchema = z
  .string()
  .nullable()
  .optional()
  .transform((v) => (v == null ? v : normalizeIban(v)))
  .refine((v) => isValidIban(v), { message: 'invalid IBAN checksum or format' });

/** Shared profile body fields for self / HR update / create (all optional). */
const profileFieldsSchema = {
  dateOfBirth: dateOfBirthSchema,
  currentAddress: z.string().nullable().optional(),
  permanentAddress: z.string().nullable().optional(),
  emergencyContacts: z
    .array(emergencyContactSchema)
    .max(2, 'at most 2 emergency contacts')
    .optional(),
  education: z.array(educationSchema).optional(),
  experience: z.array(experienceSchema).optional(),
  medicalNotes: z.string().optional(),
  cnicFrontUrl: z.string().nullable().optional(),
  cnicBackUrl: z.string().nullable().optional(),
  bankAccountHolderName: z.string().nullable().optional(),
  iban: ibanSchema,
  // Existing personal fields (kept).
  phoneNo: phoneSchema,
  emergencyPhoneNo: phoneSchema,
  address: z.string().nullable().optional(),
  bankName: z.string().nullable().optional(),
  bankAccountNo: z.string().nullable().optional(),
};

/**
 * Map validated body profile keys onto Employee model field names.
 * Keeps address ↔ currentAddress and emergencyPhoneNo ↔ emergencyContacts[0] in step.
 * Mutates `fields` in place; returns it.
 */
function applyProfileBodyToFields(body, fields) {
  if (body.dateOfBirth !== undefined) fields.DateOfBirth = body.dateOfBirth;
  if (body.permanentAddress !== undefined) fields.PermanentAddress = body.permanentAddress;
  if (body.education !== undefined) fields.Education = body.education;
  if (body.experience !== undefined) fields.Experience = body.experience;
  if (body.medicalNotes !== undefined) fields.MedicalNotes = body.medicalNotes;
  if (body.cnicFrontUrl !== undefined) fields.CnicFrontUrl = body.cnicFrontUrl;
  if (body.cnicBackUrl !== undefined) fields.CnicBackUrl = body.cnicBackUrl;
  if (body.bankAccountHolderName !== undefined) {
    fields.BankAccountHolderName = body.bankAccountHolderName;
  }
  if (body.iban !== undefined) fields.Iban = body.iban == null ? body.iban : normalizeIban(body.iban);
  if (body.bankName !== undefined) fields.BankName = body.bankName;
  if (body.bankAccountNo !== undefined) fields.BankAccountNo = body.bankAccountNo;
  if (body.phoneNo !== undefined) fields.PhoneNo = body.phoneNo;

  // Address ↔ currentAddress: accept either; keep both columns aligned when either is sent.
  if (body.currentAddress !== undefined || body.address !== undefined) {
    const value =
      body.currentAddress !== undefined ? body.currentAddress : body.address;
    fields.CurrentAddress = value;
    fields.Address = value;
  }

  if (body.emergencyContacts !== undefined) {
    fields.EmergencyContacts = body.emergencyContacts;
    // Keep legacy scalar in step with contacts[0].
    const first = body.emergencyContacts[0];
    fields.EmergencyPhoneNo = first ? first.phone : null;
  } else if (body.emergencyPhoneNo !== undefined) {
    fields.EmergencyPhoneNo = body.emergencyPhoneNo;
  }

  return fields;
}

/**
 * Private personal fields (self + HR Admin only). Managers and others never see these keys.
 */
const PRIVATE_FIELD_KEYS = [
  'dateOfBirth',
  'medicalNotes',
  'cnicFrontUrl',
  'cnicBackUrl',
  'bankName',
  'bankAccountNo',
  'bankAccountHolderName',
  'iban',
  'monthlySalary',
  'phoneNo',
  'emergencyPhoneNo',
  'address',
  'currentAddress',
  'permanentAddress',
  'emergencyContacts',
  'education',
  'experience',
];

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  // pg may return jsonb already parsed; if string, try once.
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Attach private profile fields onto `out` when the caller may see them.
 * Always materializes empty defaults so clients can distinguish empty vs unsupported.
 */
function attachPrivateProfileFields(out, f) {
  const current = f.CurrentAddress != null && f.CurrentAddress !== '' ? f.CurrentAddress : f.Address;
  const address = f.Address != null && f.Address !== '' ? f.Address : f.CurrentAddress;

  out.dateOfBirth = f.DateOfBirth || null;
  out.medicalNotes = f.MedicalNotes == null ? '' : String(f.MedicalNotes);
  out.cnicFrontUrl = f.CnicFrontUrl || null;
  out.cnicBackUrl = f.CnicBackUrl || null;
  out.bankName = f.BankName || null;
  out.bankAccountNo = f.BankAccountNo || null;
  out.bankAccountHolderName = f.BankAccountHolderName || null;
  out.iban = f.Iban || null;
  out.monthlySalary = f.MonthlySalary ?? null;
  out.phoneNo = f.PhoneNo || null;
  out.emergencyPhoneNo = f.EmergencyPhoneNo || null;
  out.address = address || null;
  out.currentAddress = current || null;
  out.permanentAddress = f.PermanentAddress || null;
  out.emergencyContacts = asArray(f.EmergencyContacts);
  out.education = asArray(f.Education);
  out.experience = asArray(f.Experience);
  return out;
}

module.exports = {
  PHONE_RE,
  profileFieldsSchema,
  applyProfileBodyToFields,
  attachPrivateProfileFields,
  PRIVATE_FIELD_KEYS,
  isValidIban,
  normalizeIban,
  maxDateOfBirthIso,
  todayIso,
};
