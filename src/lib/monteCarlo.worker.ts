import { runMonteCarloSimulation } from "@/lib/monteCarlo";
import { maximizeSpending, suggestWithdrawalOrder, type MaximumSpendingResult, type WithdrawalObjective, type WithdrawalOrderSuggestion } from "@/lib/workingForecast";
import type { RetirementInputs, SimulationOutput } from "@/types/retirement";

export type MonteCarloWorkerMessage =
  | { type: "progress"; completed: number; total: number }
  | { type: "complete"; output: SimulationOutput }
  | { type: "error"; message: string };

export type MaximumSpendingWorkerMessage =
  | { type: "spending-progress"; evaluations: number }
  | { type: "spending-complete"; output: MaximumSpendingResult }
  | { type: "error"; message: string };

export type WithdrawalOrderWorkerMessage =
  | { type: "order-progress"; completed: number; total: number; evaluations: number }
  | { type: "order-complete"; output: WithdrawalOrderSuggestion }
  | { type: "error"; message: string };

function send(message: MonteCarloWorkerMessage | MaximumSpendingWorkerMessage | WithdrawalOrderWorkerMessage) {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<RetirementInputs | { type: "maximize-spending"; inputs: RetirementInputs }
  | { type: "suggest-withdrawal-order"; inputs: RetirementInputs; objective: WithdrawalObjective }>) => {
  try {
    if ("type" in event.data) {
      if (event.data.type === "suggest-withdrawal-order") {
        const output = suggestWithdrawalOrder(event.data.inputs, event.data.objective,
          (completed, total, evaluations) => send({ type: "order-progress", completed, total, evaluations }));
        send({ type: "order-complete", output });
        return;
      }
      const output = maximizeSpending(event.data.inputs, (evaluations) => send({ type: "spending-progress", evaluations }));
      send({ type: "spending-complete", output });
      return;
    }
    const output = runMonteCarloSimulation(event.data, (completed, total) => send({ type: "progress", completed, total }));
    send({ type: "complete", output });
  } catch (cause) {
    send({ type: "error", message: cause instanceof Error ? cause.message : "The simulation could not be completed." });
  }
};