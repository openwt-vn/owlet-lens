const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const workflowPath = path.join(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'ai-review-reusable.yml');

function loadWorkflow() {
  const raw = fs.readFileSync(workflowPath, 'utf8');
  return yaml.load(raw);
}

function actionStepWith(job) {
  const step = job.steps.find((s) => s.uses?.startsWith('openwt-vn/owlet-lens@'));
  assert.ok(step, 'job must have a step invoking the reusable action');
  return step;
}

// Reflection builds its LLM from config.reply, so every job that runs
// `subcommand: review` must forward reply-model. Missing it makes reflection
// fall back to the caller's config reply.model (or the built-in default).
test('reusable review job forwards reply-model to the action', () => {
  const workflow = loadWorkflow();
  const step = actionStepWith(workflow.jobs.review);

  assert.equal(step.with.subcommand, 'review');
  assert.equal(step.with['reply-model'], '${{ inputs.reply-model }}');
});

test('reusable review-on-demand job forwards reply-model to the action', () => {
  const workflow = loadWorkflow();
  const step = actionStepWith(workflow.jobs['review-on-demand']);

  assert.equal(step.with.subcommand, 'review');
  assert.equal(step.with['reply-model'], '${{ inputs.reply-model }}');
});

test('reusable reply job forwards reply-model to the action', () => {
  const workflow = loadWorkflow();
  const step = actionStepWith(workflow.jobs.reply);

  assert.equal(step.with.subcommand, 'reply');
  assert.equal(step.with['reply-model'], '${{ inputs.reply-model }}');
});

test('every reusable review job passes the same reply-model as the reply job', () => {
  const workflow = loadWorkflow();
  const expected = actionStepWith(workflow.jobs.reply).with['reply-model'];

  assert.ok(expected, 'reply job must forward reply-model');
  for (const name of ['review', 'review-on-demand']) {
    assert.equal(
      actionStepWith(workflow.jobs[name]).with['reply-model'],
      expected,
      `${name} must forward the same reply-model as reply, or reflection runs on config reply.model`,
    );
  }
});

test('reusable workflow declares reply-model as a workflow_call input', () => {
  const workflow = loadWorkflow();
  // js-yaml parses the `on:` key as boolean `true` under YAML 1.1 core schema
  const on = workflow.on || workflow[true];
  const input = on.workflow_call.inputs['reply-model'];

  assert.ok(input, 'workflow_call.inputs.reply-model must be declared');
  assert.equal(input.required, false);
});

// --- TL gate (review.tlGate): no template change on GitHub -------------------
// GitHub's button is "Re-run all jobs", which the gate recognises from
// GITHUB_RUN_ATTEMPT > 1 on a pull_request event. Neither input exists here, and
// adding one would be the wrong fix: the whole point is that the gate reads the
// platform's own run facts, so no caller has to declare who pressed anything.

test('reusable review job needs no gate input — the press is GitHub\u2019s own re-run', () => {
  const workflow = loadWorkflow();
  const on = workflow.on || workflow[true];
  const step = actionStepWith(workflow.jobs.review);

  assert.ok(
    step.with['tl-press'] === undefined && step.with['tl-pressed'] === undefined,
    'the gate must not depend on a caller-declared "was this a press" input',
  );
  assert.ok(
    !(on.workflow_call.inputs ?? {})['tl-press'],
    'no tl-press workflow_call input may be declared',
  );
});

test('reusable review job still runs on a plain pull_request, so a re-run reaches it', () => {
  const workflow = loadWorkflow();

  assert.ok(
    workflow.jobs.review.if.includes("github.event_name == 'pull_request'"),
    'the review job must not gain a condition that skips the button run',
  );
});

test('reusable learn job does not pass reply-model (learn never reflects)', () => {
  const workflow = loadWorkflow();
  const step = actionStepWith(workflow.jobs.learn);

  assert.equal(step.with.subcommand, 'learn');
  assert.equal(step.with['reply-model'], undefined);
});

test('the reusable workflow never picks a runner for the caller: runner is required and has no default', () => {
  const wf = loadWorkflow();
  const input = (wf.on || wf[true]).workflow_call.inputs.runner;
  assert.equal(input.required, true);
  assert.equal(input.default, undefined, 'a default would choose a runner for someone who did not ask');
  const text = fs.readFileSync(workflowPath, 'utf8');
  for (const line of text.split('\n').filter((l) => l.trim().startsWith('runs-on:'))) {
    assert.match(line, /fromJSON\(inputs\.runner\)/, `every job takes its runner from the input: ${line.trim()}`);
  }
});

test('the reusable reply job starts only for OWNER, MEMBER and COLLABORATOR comments', () => {
  const cond = loadWorkflow().jobs.reply.if;
  assert.match(cond, /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.comment\.author_association\)/);
  assert.match(cond, /github\.event\.comment\.user\.type != 'Bot'/);
});
