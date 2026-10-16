import { Filter, Redo2, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import type { TaskState } from '../shared/graph';
import { useApp } from './App';
import { ALL, type Reach, type Seed, type Step, type StepOp, STEP_OPS, stepLabel, TASK_STATES } from './steps';

/** A new step that is on. */
export const newStep = (op: StepOp, seed: Seed, reach: Reach = { up: 0, down: 0 }): Step => ({ id: crypto.randomUUID(), op, seed, reach, on: true });

/** Apply a step to the current list. Show starts a new list: nothing before it would count. */
export const withStep = (steps: Step[], s: Step): Step[] => (s.op === 'replace' ? [s] : [...steps, s]);

const REACH = [0, 1, 2, 3, 4, 5, ALL];
const reachName = (n: number) => (n === 0 ? 'none' : n === ALL ? 'all' : `${n} level${n > 1 ? 's' : ''}`);

function ReachSelect(p: { label: string; value: number; onChange(n: number): void }) {
  return (
    <label className="reach">
      <span>{p.label}</span>
      <select value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} aria-label={p.label}>
        {REACH.map((n) => (
          <option key={n} value={n}>
            {reachName(n)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Build filter steps from the selection or a task state, and list, toggle, and remove them. */
export function StepsPanel({ selection }: { selection: string[] }) {
  const { steps, setSteps, canBack, canForward, back, forward, byId } = useApp();
  const [seedKind, setSeedKind] = useState<'selection' | TaskState>('selection');
  const [reach, setReach] = useState<Reach>({ up: 0, down: 0 });
  const seed: Seed = seedKind === 'selection' ? { type: 'nodes', ids: selection } : { type: 'state', states: [seedKind] };
  const empty = seedKind === 'selection' && !selection.length;
  return (
    <fieldset className="steps">
      <legend>
        <Filter size={12} /> Steps
      </legend>
      <select value={seedKind} onChange={(e) => setSeedKind(e.target.value as typeof seedKind)} aria-label="Start from">
        <option value="selection">the selection ({selection.length})</option>
        {TASK_STATES.map((s) => (
          <option key={s} value={s}>
            {s} tasks
          </option>
        ))}
      </select>
      <div className="reach-row">
        <ReachSelect label="Parents" value={reach.up} onChange={(up) => setReach({ ...reach, up })} />
        <ReachSelect label="Children" value={reach.down} onChange={(down) => setReach({ ...reach, down })} />
      </div>
      <div className="step-ops">
        {(Object.keys(STEP_OPS) as StepOp[]).map((op) => (
          <button key={op} type="button" className="btn small" disabled={empty} title={OP_HELP[op]} onClick={() => setSteps(withStep(steps, newStep(op, seed, reach)))}>
            {STEP_OPS[op]}
          </button>
        ))}
      </div>
      {steps.length > 0 && (
        <ol className="step-list">
          {steps.map((s, i) => (
            <li key={s.id} className={s.on ? '' : 'off'}>
              <label className="check" title={s.on ? 'On: click to turn this step off' : 'Off: click to turn this step on'}>
                <input type="checkbox" checked={s.on} onChange={() => setSteps(steps.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))} />
                <span>{stepLabel(s, byId)}</span>
              </label>
              <button type="button" className="icon" aria-label="Remove step" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="step-history">
        <button type="button" className="icon" aria-label="Back" title="Back to the previous steps" disabled={!canBack} onClick={back}>
          <Undo2 size={16} />
        </button>
        <button type="button" className="icon" aria-label="Forward" title="Forward again" disabled={!canForward} onClick={forward}>
          <Redo2 size={16} />
        </button>
        <button type="button" className="btn small" disabled={!steps.length} title="Remove every step and show the whole graph" onClick={() => setSteps([])}>
          Show all
        </button>
      </div>
    </fieldset>
  );
}

const OP_HELP: Record<StepOp, string> = {
  replace: 'Start over: show only these',
  union: 'Add these to what is shown',
  intersect: 'Of what is shown, keep only these',
  subtract: 'Hide these',
};
