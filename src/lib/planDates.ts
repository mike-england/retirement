import type { PersonalInfo } from "@/types/retirement";

export const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type AgedPerson = { currentAge: number; birthMonth?: number };

export function monthYearLabel(person: AgedPerson, targetAge: number, baseYear = new Date().getFullYear(), monthOverride?: number) {
  const year = baseYear + targetAge - person.currentAge;
  const month = monthOverride ?? person.birthMonth;
  return month ? `${monthNames[month - 1]} ${year}` : `${year} (set a birth month above for an exact month)`;
}

export function ageYearLabel(person: AgedPerson, targetAge: number, baseYear = new Date().getFullYear()) {
  return String(baseYear + targetAge - person.currentAge);
}

// How many years from now the household's last surviving member reaches their own target death age.
export function householdMaxYearIndex(personalInfo: PersonalInfo) {
  return Math.max(
    personalInfo.targetDeathAge - personalInfo.currentAge,
    ...(personalInfo.additionalPeople ?? []).map((person) => person.targetDeathAge - person.currentAge),
  );
}

// The highest age that still falls within the household's overall lifespan, expressed in this specific person's own age scale -
// e.g. if a younger spouse outlives the primary, this can be higher than that person's own targetDeathAge.
export function maxHouseholdAge(person: AgedPerson, personalInfo: PersonalInfo) {
  return person.currentAge + householdMaxYearIndex(personalInfo);
}
