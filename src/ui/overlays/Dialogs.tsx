import { useState } from "react";
import { closeOverlay } from "../../state/overlays";
import { Modal } from "./Modal";

export function ConfirmDialog(props: { title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void }) {
  const run = () => {
    closeOverlay();
    props.onConfirm();
  };
  return (
    <Modal
      title={props.title}
      width={420}
      footer={
        <>
          <button className="btn" onClick={closeOverlay}>
            Cancel
          </button>
          <button className={`btn ${props.danger ? "btn-danger" : "btn-primary"}`} autoFocus onClick={run}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <p className="dialog-message">{props.message}</p>
    </Modal>
  );
}

export function PromptDialog(props: { title: string; label: string; value: string; onSubmit: (v: string) => void }) {
  const [value, setValue] = useState(props.value);
  const submit = () => {
    closeOverlay();
    props.onSubmit(value);
  };
  return (
    <Modal
      title={props.title}
      width={420}
      footer={
        <>
          <button className="btn" onClick={closeOverlay}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit}>
            Save
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">{props.label}</span>
        <input
          className="input"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </label>
    </Modal>
  );
}
