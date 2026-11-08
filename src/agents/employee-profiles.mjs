// Approved employee metadata is descriptive only; it never grants runtime authority.
import { readFileSync } from "node:fs";

const PROFILE_FIELDS = [
  "id",
  "name",
  "role",
  "division",
  "specialties",
  "style",
  "bio",
  "source",
];
const SOURCE_FIELDS = ["project", "id", "employeeId", "sha256"];
const SNAPSHOT_FIELDS = [
  "version",
  "source",
  "sourceCount",
  "sourceHash",
  "profiles",
];
const APPROVED_IDS = new Set(["designer", "researcher", "reviewer"]);
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const EMPLOYEE_ID = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const SHA256 = /^[a-f0-9]{64}$/;
let cachedProfiles;

function requireFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be an object");
  for (const key of Object.keys(value))
    if (!fields.includes(key))
      throw new Error(label + " field not allowed: " + key);
  for (const key of fields)
    if (!Object.hasOwn(value, key))
      throw new Error(label + "." + key + " is required");
}

function requireText(value, field, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(field + " must be 1-" + maximum + " characters");
}

export function validateEmployeeProfile(profile) {
  requireFields(profile, PROFILE_FIELDS, "employeeProfile");
  if (typeof profile.id !== "string" || !ID.test(profile.id))
    throw new Error("Invalid employeeProfile.id");
  requireText(profile.name, "employeeProfile.name", 80);
  requireText(profile.role, "employeeProfile.role", 80);
  requireText(profile.division, "employeeProfile.division", 80);
  if (
    !Array.isArray(profile.specialties) ||
    profile.specialties.length < 1 ||
    profile.specialties.length > 12
  )
    throw new Error("employeeProfile.specialties must contain 1-12 entries");
  for (const specialty of profile.specialties)
    requireText(specialty, "employeeProfile.specialties entry", 80);
  requireText(profile.style, "employeeProfile.style", 240);
  requireText(profile.bio, "employeeProfile.bio", 500);
  requireFields(profile.source, SOURCE_FIELDS, "employeeProfile.source");
  requireText(profile.source.project, "employeeProfile.source.project", 80);
  if (typeof profile.source.id !== "string" || !ID.test(profile.source.id))
    throw new Error("Invalid employeeProfile.source.id");
  if (profile.source.id !== profile.id)
    throw new Error("employeeProfile.source.id must match employeeProfile.id");
  if (
    typeof profile.source.employeeId !== "string" ||
    profile.source.employeeId.length > 64 ||
    !EMPLOYEE_ID.test(profile.source.employeeId)
  )
    throw new Error("Invalid employeeProfile.source.employeeId");
  if (
    typeof profile.source.sha256 !== "string" ||
    !SHA256.test(profile.source.sha256)
  )
    throw new Error("Invalid employeeProfile.source.sha256");
  return profile;
}

function loadProfiles() {
  let data;
  try {
    const fixedUrl = new URL("./data/employee-templates.json", import.meta.url);
    data = JSON.parse(readFileSync(fixedUrl, "utf8"));
  } catch {
    throw new Error(
      "Employee profile snapshot is missing, unreadable, or invalid JSON",
    );
  }
  try {
    requireFields(data, SNAPSHOT_FIELDS, "employee snapshot");
    if (
      data.version !== 1 ||
      data.source !== "Sample Team Templates" ||
      data.sourceCount !== 3
    )
      throw new Error("Unsupported employee snapshot metadata");
    if (typeof data.sourceHash !== "string" || !SHA256.test(data.sourceHash))
      throw new Error("Invalid employee snapshot sourceHash");
    if (
      !Array.isArray(data.profiles) ||
      data.profiles.length !== APPROVED_IDS.size
    )
      throw new Error(
        "Employee snapshot must contain the 3 approved profiles",
      );
    const ids = new Set();
    const employeeIds = new Set();
    for (const profile of data.profiles) {
      validateEmployeeProfile(profile);
      if (!APPROVED_IDS.has(profile.id))
        throw new Error("Unapproved employee id: " + profile.id);
      if (ids.has(profile.id) || employeeIds.has(profile.source.employeeId))
        throw new Error("Duplicate employee profile or source employee id");
      if (
        profile.source.project !== "Sample-Team" ||
        profile.source.sha256 !== data.sourceHash
      )
        throw new Error(
          "Employee source provenance does not match the snapshot",
        );
      ids.add(profile.id);
      employeeIds.add(profile.source.employeeId);
    }
  } catch (error) {
    throw new Error("Employee profile snapshot is invalid: " + error.message);
  }
  return data.profiles;
}

function approvedProfiles() {
  if (!cachedProfiles) cachedProfiles = loadProfiles();
  return cachedProfiles;
}

export function listEmployeeProfiles() {
  return structuredClone(approvedProfiles());
}

export function getEmployeeProfile(id) {
  if (typeof id !== "string" || !ID.test(id))
    throw new Error("Unknown employee profile id");
  const profile = approvedProfiles().find((candidate) => candidate.id === id);
  if (!profile) throw new Error("Unknown employee profile: " + id);
  return structuredClone(profile);
}
