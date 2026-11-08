import type { ExistingAssets, InvestmentAccount, RetirementInputs } from "@/types/retirement";

export function accountEntriesFor(assets: ExistingAssets | undefined, currentAge: number, fallbackRate = 0.05): InvestmentAccount[] {
  if (assets?.accounts) return assets.accounts;
  const accounts: InvestmentAccount[] = [];
  for (const [type, balance, name] of [
    ["rrsp", assets?.rrspBalance ?? 0, "RRSP / RRIF"],
    ["tfsa", assets?.tfsaBalance ?? 0, "TFSA"],
    ["nonRegistered", assets?.nonRegisteredBalance ?? 0, "Non-registered"],
  ] as const) {
    if (balance > 0 || (type === "nonRegistered" && (assets?.nonRegisteredBookValue ?? 0) > 0)) {
      accounts.push({ id: `existing-${type}`, name, balance, type, returnType: "market", bookValue: type === "nonRegistered" ? assets?.nonRegisteredBookValue ?? 0 : undefined });
    }
  }
  const holdings = assets?.gics?.length ? assets.gics : ((assets?.interestBearingBalance ?? 0) > 0 ? [{
    id: "legacy", label: "GIC", balance: assets!.interestBearingBalance!, rate: assets?.interestBearingRate ?? fallbackRate,
    termYears: assets?.interestBearingTermYears ?? 1, startAge: currentAge, fundingSource: "nonRegistered" as const, maturityAction: "renew" as const,
  }] : []);
  for (const holding of holdings) {
    const termYears = Math.max(1, holding.termYears);
    accounts.push({
      id: holding.id, name: holding.label || "GIC", balance: holding.balance,
      type: holding.fundingSource === "registered" ? "rrsp" : holding.fundingSource === "tfsa" ? "tfsa" : "nonRegistered",
      returnType: "gic", annualRate: (1 + holding.rate) ** (1 / termYears) - 1, termYears,
      startAge: holding.startAge, maturityAction: holding.maturityAction,
    });
  }
  return accounts;
}

export function assetsWithAccounts(assets: ExistingAssets | undefined, accounts: InvestmentAccount[], currentAge: number): ExistingAssets {
  const next: ExistingAssets = {
    ...assets, accounts, rrspBalance: 0, tfsaBalance: 0, nonRegisteredBalance: 0, nonRegisteredBookValue: 0, interestBearingBalance: 0, gics: [],
  };
  for (const account of accounts) {
    const balance = Math.max(0, account.balance);
    if (account.returnType === "market") {
      if (account.type === "rrsp") next.rrspBalance += balance;
      else if (account.type === "tfsa") next.tfsaBalance += balance;
      else {
        next.nonRegisteredBalance += balance;
        next.nonRegisteredBookValue += Math.max(0, account.bookValue ?? balance);
      }
    } else {
      const termYears = account.returnType === "savings" ? 1 : Math.max(1, account.termYears ?? 1);
      next.gics!.push({
        id: account.id, label: account.name, balance, rate: (1 + Math.max(0, account.annualRate ?? 0.05)) ** termYears - 1,
        termYears, startAge: account.startAge ?? currentAge,
        fundingSource: account.type === "rrsp" ? "registered" : account.type === "tfsa" ? "tfsa" : "nonRegistered",
        maturityAction: account.returnType === "savings" ? "renew" : account.maturityAction ?? "renew",
      });
    }
  }
  return next;
}

export function withAccountBalances(inputs: RetirementInputs): RetirementInputs {
  return {
    ...inputs,
    existingAssets: inputs.existingAssets.accounts ? assetsWithAccounts(inputs.existingAssets, inputs.existingAssets.accounts, inputs.personalInfo.currentAge) : inputs.existingAssets,
    personalInfo: {
      ...inputs.personalInfo,
      additionalPeople: (inputs.personalInfo.additionalPeople ?? []).map((person) => person.existingAssets?.accounts
        ? { ...person, existingAssets: assetsWithAccounts(person.existingAssets, person.existingAssets.accounts, person.currentAge) } : person),
    },
  };
}

export function accountTotal(accounts: InvestmentAccount[]): number {
  return accounts.reduce((total, account) => total + Math.max(0, account.balance), 0);
}