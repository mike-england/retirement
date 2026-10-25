"use client";

import { Copy, Download, Eye, EyeOff, LockKeyhole, Replace, UnlockKeyhole } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

type ScenarioFileDialogProps = {
  mode: "export" | "import";
  onSubmit: (password?: string) => Promise<void>;
  onClose: () => void;
};

type ScenarioImportConflictDialogProps = {
  name: string;
  onResolve: (choice: "copy" | "replace") => void;
  onClose: () => void;
};

export function ScenarioImportConflictDialog({ name, onResolve, onClose }: ScenarioImportConflictDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  function resolve(choice: "copy" | "replace") {
    try {
      onResolve(choice);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to import the scenario.");
    }
  }

  return (
    <dialog ref={dialogRef} className="scenario-file-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}>
      <form onSubmit={(event) => { event.preventDefault(); resolve("copy"); }}>
        <h2 id={titleId}>Scenario already exists</h2>
        <p id={descriptionId} className="scenario-file-conflict">A scenario named &ldquo;{name}&rdquo; already exists.</p>
        {error && <p className="scenario-file-error" role="alert">{error}</p>}
        <div className="scenario-file-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="button button-quiet" onClick={() => resolve("replace")}>
            <Replace size={16} /> Replace existing
          </button>
          <button type="submit" className="button button-primary" autoFocus><Copy size={16} /> Keep both</button>
        </div>
      </form>
    </dialog>
  );
}

export function ScenarioFileDialog({ mode, onSubmit, onClose }: ScenarioFileDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [encrypted, setEncrypted] = useState(mode === "import");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (encrypted && mode === "export" && password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(encrypted ? password : undefined);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to process the scenario file.");
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="scenario-file-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <form onSubmit={submit} aria-busy={busy}>
        <h2 id={titleId}>{mode === "export" ? "Export scenario" : "Unlock scenario"}</h2>
        <fieldset disabled={busy}>
          {mode === "export" && (
            <label className="scenario-file-check">
              <input type="checkbox" checked={encrypted} onChange={(event) => {
                setEncrypted(event.target.checked);
                setPassword("");
                setConfirmation("");
                setError("");
              }} />
              Password protect file
            </label>
          )}
          {encrypted && (
            <>
              <label className="scenario-file-field">
                {mode === "export" ? "Password (12+ characters recommended)" : "Password"}
                <span className="scenario-file-password">
                  <input type={showPassword ? "text" : "password"} required
                    autoComplete={mode === "export" ? "new-password" : "current-password"} value={password}
                    onChange={(event) => setPassword(event.target.value)} autoFocus={mode === "import"} />
                  <button type="button" className="button button-quiet" title={showPassword ? "Hide password" : "Show password"}
                    aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword}
                    onClick={() => setShowPassword(!showPassword)}>
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </span>
              </label>
              {mode === "export" && (
                <label className="scenario-file-field">
                  Confirm password
                  <input type={showPassword ? "text" : "password"} required autoComplete="new-password"
                    value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
                </label>
              )}
              <p className="scenario-file-warning">
                {mode === "export" ? "Lost passwords cannot be recovered. Browser-saved scenarios remain unencrypted." : "The imported scenario will be saved unencrypted in this browser."}
              </p>
            </>
          )}
        </fieldset>
        {error && <p className="scenario-file-error" role="alert">{error}</p>}
        <div className="scenario-file-actions">
          <button type="button" className="button button-quiet" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {mode === "import" ? <UnlockKeyhole size={16} /> : encrypted ? <LockKeyhole size={16} /> : <Download size={16} />}
            {busy ? "Processing..." : mode === "import" ? "Unlock and import" : encrypted ? "Export encrypted" : "Export JSON"}
          </button>
        </div>
      </form>
    </dialog>
  );
}