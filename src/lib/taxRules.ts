import { TAX_BRACKETS, type Rate, type TaxBracket } from "@equisoft/tax-ca";
import type {
  ProvinceCode,
  TaxJurisdictionSettings,
  TaxRateBracket,
  TaxSettings,
} from "@/types/retirement";

const provinceCodes: ProvinceCode[] = [
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
];

export const availableTaxYears = [2026] as const;

export const provinceNames: Record<ProvinceCode, string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

export const defaultTaxSettings: TaxSettings = {
  taxYear: 2026,
  source: "@equisoft/tax-ca 2026.9",
  federal: adaptJurisdiction(TAX_BRACKETS.CA),
  provinces: Object.fromEntries(
    provinceCodes.map((province) => [province, adaptJurisdiction(TAX_BRACKETS[province])]),
  ) as Record<ProvinceCode, TaxJurisdictionSettings>,
};

function adaptJurisdiction(bracket: TaxBracket): TaxJurisdictionSettings {
  return {
    basicPersonalAmount: typeof bracket.BASIC_PERSONAL_AMOUNT === "number"
      ? bracket.BASIC_PERSONAL_AMOUNT
      : bracket.BASIC_PERSONAL_AMOUNT.MAX,
    taxCreditRate: bracket.TAX_CREDIT_RATE,
    abatementRate: bracket.ABATEMENT,
    brackets: adaptRates(bracket.RATES),
    surtaxBrackets: adaptRates(bracket.SURTAX_RATES),
  };
}

function adaptRates(rates: Rate[]): TaxRateBracket[] {
  return rates.map((rate) => ({
    from: rate.FROM,
    to: Number.isFinite(rate.TO) ? rate.TO : null,
    rate: rate.RATE,
  }));
}
