import { runMonteCarloSimulation } from "@/lib/monteCarlo";
import type { RetirementInputs, SimulationOutput } from "@/types/retirement";

export type MonteCarloWorkerMessage =
  | { type: "progress"; completed: number; total: number }
  | { type: "complete"; output: SimulationOutput }
  | { type: "error"; message: string };

function send(message: MonteCarloWorkerMessage) {
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<RetirementInputs>) => {
  try {
    const output = runMonteCarloSimulation(event.data, (completed, total) => send({ type: "progress", completed, total }));
    send({ type: "complete", output });
  } catch (cause) {
    send({ type: "error", message: cause instanceof Error ? cause.message : "The simulation could not be completed." });
  }
};