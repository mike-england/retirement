import type { PersonalInfo } from "@/types/retirement";

export const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type AgedPerson = { currentAge: number; birthMonth?: number };

// The calendar year+month a person turns a given age. Every age boundary in this app (income start/end, spending phases,
// death age) is a birthday cutoff: you have it up through the month before your birthday, then it changes on the birthday.
// monthOverride lets a specific event (e.g. an income stream's own start/end) use a different month than the birthday.
export function ageToMonthYear(person: AgedPerson, targetAge: number, baseYear = new Date().getFullYear(), monthOverride?: number) {
  const yearIndex = targetAge - person.currentAge;
  return { year: baseYear + yearIndex, month: monthOverride ?? person.birthMonth ?? 1 };
}

export function monthYearLabel(person: AgedPerson, targetAge: number, baseYear?: number, monthOverride?: number) {
  const { year, month } = ageToMonthYear(person, targetAge, baseYear, monthOverride);
  return (monthOverride ?? person.birthMonth) ? `${monthNames[month - 1]} ${year}` : `${year} (set a birth month above for an exact month)`;
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
