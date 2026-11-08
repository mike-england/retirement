import { rollingReforecast, type RollingReforecast } from "@/lib/actuals";
import type { ActualsBaseline, BalanceObservation, ForecastRevision } from "@/types/retirement";

export type ActualsWorkerMessage = { type: "complete"; output: RollingReforecast } | { type: "error"; message: string };

self.onmessage = (event: MessageEvent<{ baseline: ActualsBaseline; observations: BalanceObservation[]; comparisonDates?: string[]; revisions?: ForecastRevision[] }>) => {
  try {
    const output = rollingReforecast(event.data.baseline, event.data.observations, event.data.comparisonDates, event.data.revisions);
    delete output.projection;
    const message: ActualsWorkerMessage = { type: "complete", output };
    self.postMessage(message);
  } catch (failure) {
    const message: ActualsWorkerMessage = { type: "error", message: failure instanceof Error ? failure.message : "Unable to calculate the rolling reforecast." };
    self.postMessage(message);
  }
};