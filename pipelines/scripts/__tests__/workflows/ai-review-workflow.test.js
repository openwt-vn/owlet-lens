const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const workflowsDir = path.join(__dirname, '..', '..', '..', '..', '.github', 'workflows');

function loadWorkflow(file = 'ai-review.yml') {
  const raw = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
  return yaml.load(raw);
}

function actionStepWith(job) {
  const step = job.steps.find((s) => s.uses === './');
  assert.ok(step, 'job must have a step invoking the local action (./)');
  return step;
}

test('ai-review.yml declares schedule and workflow_dispatch triggers', () => {
  const workflow = loadWorkflow();
  // js-yaml parses the `on:` key as boolean `true` under YAML 1.1 core schema
  const on = workflow.on || workflow[true];

  assert.ok(Array.isArray(on.schedule), 'on.schedule must be an array');
  assert.equal(on.schedule.length, 1);
  assert.equal(on.schedule[0].cron, '0 3 1,15 * *');

  assert.ok(on.workflow_dispatch, 'on.workflow_dispatch must be present');
  assert.equal(on.workflow_dispatch.inputs.dry_run.type, 'boolean');
  assert.equal(on.workflow_dispatch.inputs.dry_run.default, false);
});

test('ai-review.yml declares a learn job gated on schedule or workflow_dispatch', () => {
  const workflow = loadWorkflow();
  const learn = workflow.jobs.learn;

  assert.ok(learn, 'jobs.learn must be present');
  assert.equal(learn.if, "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'");
  assert.equal(learn.permissions.contents, 'write');
  assert.equal(learn.permissions['pull-requests'], 'write');
});

test('learn job uses the local action with subcommand learn and PAT-fallback token', () => {
  const workflow = loadWorkflow();
  const steps = workflow.jobs.learn.steps;
  const actionStep = steps.find((s) => s.uses === './');

  assert.ok(actionStep, 'learn job must have a step using the local action (./)');
  assert.equal(actionStep.with.subcommand, 'learn');
  assert.equal(actionStep.with['github-token'], "${{ secrets.AI_REVIEW_RESOLVE_TOKEN || github.token }}");
});

test('review and reply jobs are unchanged (contents: read)', () => {
  const workflow = loadWorkflow();

  assert.equal(workflow.jobs.review.permissions.contents, 'read');
  assert.equal(workflow.jobs.reply.permissions.contents, 'read');
});

test('review job passes reply-model for reflection', () => {
  const workflow = loadWorkflow();
  assert.equal(
    actionStepWith(workflow.jobs.review).with['reply-model'],
    '${{ vars.AI_REPLY_MODEL }}',
  );
});

test('review-on-demand job passes reply-model for reflection', () => {
  const workflow = loadWorkflow();
  assert.equal(
    actionStepWith(workflow.jobs['review-on-demand']).with['reply-model'],
    '${{ vars.AI_REPLY_MODEL }}',
  );
});

test('every review job passes the same reply-model as the reply job', () => {
  const workflow = loadWorkflow();
  const expected = actionStepWith(workflow.jobs.reply).with['reply-model'];

  assert.ok(expected, 'reply job must pass reply-model');
  for (const name of ['review', 'review-on-demand']) {
    assert.equal(
      actionStepWith(workflow.jobs[name]).with['reply-model'],
      expected,
      `${name} must pass the same reply-model as reply, or reflection runs on config reply.model`,
    );
  }
});

// --- TL gate (review.tlGate): no template change on GitHub -------------------
// The button is GitHub's own "Re-run all jobs", which the gate recognises from
// GITHUB_RUN_ATTEMPT > 1. So the proof that this platform needs no template
// change is that the trigger list is untouched and the review job still runs on
// a plain pull_request.

test('pull_request trigger is unchanged by the TL gate (GitHub needs no new template)', () => {
  const workflow = loadWorkflow();
  const on = workflow.on || workflow[true];

  assert.deepEqual(
    on.pull_request.types,
    ['opened', 'synchronize', 'reopened'],
    'the gate is decided in code, not by changing what triggers the workflow',
  );
  assert.ok(!on.pull_request_target, 'no pull_request_target trigger may be added for the gate');
});

test('the review job still runs on a plain pull_request, so a re-run reaches it', () => {
  const workflow = loadWorkflow();

  // Still a plain pull_request. Only pull requests from forks are skipped: they get no secrets,
  // so there is nothing to review with.
  assert.equal(
    workflow.jobs.review.if,
    "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository",
  );
  assert.equal(actionStepWith(workflow.jobs.review).with.subcommand, 'review');
});

test('every job takes its runner from CI_RUNNER and defaults to GitHub-hosted', () => {
  for (const file of ['ci.yml', 'ai-review.yml']) {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '.github', 'workflows', file), 'utf8');
    const runsOn = text.split('\n').filter((l) => l.trim().startsWith('runs-on:'));
    assert.ok(runsOn.length > 0, `${file} has jobs`);
    for (const line of runsOn) {
      assert.ok(
        line.includes('vars.CI_RUNNER') && line.includes("'ubuntu-latest'") && !line.includes('self-hosted'),
        `${file}: a runner is never hard-coded to self-hosted: ${line.trim()}`,
      );
    }
  }
});

test('the reply job answers review-thread comments only on pull requests of this repository', () => {
  const workflow = loadWorkflow();
  const condition = workflow.jobs.reply.if;

  assert.ok(
    condition.includes("github.event_name == 'pull_request_review_comment'") &&
      condition.includes('github.event.pull_request.head.repo.full_name == github.repository'),
    'a comment on a fork pull request checks out the fork code and has no secrets, so it must not start the job',
  );
});

test('the reply job starts only for OWNER, MEMBER and COLLABORATOR comments', () => {
  const workflow = loadWorkflow();
  const condition = workflow.jobs.reply.if;

  assert.ok(
    condition.includes('\'["OWNER","MEMBER","COLLABORATOR"]\'') && condition.includes('github.event.comment.author_association'),
    'anyone can comment on a public repository, and every reply costs a model call',
  );
  assert.ok(!condition.includes('CONTRIBUTOR'), 'a past contributor is not a role in this repository');
});

test('review-on-demand (/review comment) is separate from the gate and cannot open it', () => {
  const workflow = loadWorkflow();
  const job = workflow.jobs['review-on-demand'];

  assert.ok(job.if.includes('issue_comment'), 'the /review path is a comment event');
  assert.ok(
    !job.if.includes("event_name == 'pull_request'"),
    'a /review run must never look like a button press: the gate keys off GITHUB_EVENT_NAME, which is issue_comment here',
  );
});

test('review-on-demand job triggers on /review comment in PRs', () => {
  const workflow = loadWorkflow();
  const job = workflow.jobs['review-on-demand'];

  assert.ok(job, 'jobs.review-on-demand must be present');
  assert.ok(job.if.includes('issue_comment'), 'must trigger on issue_comment');
  assert.ok(job.if.includes('/review'), 'must check for /review command');
  assert.equal(job.permissions.contents, 'read');
  assert.equal(job.permissions['pull-requests'], 'write');

  const actionStep = job.steps.find((s) => s.uses === './');
  assert.ok(actionStep, 'must use local action');
  assert.equal(actionStep.with.subcommand, 'review');

  const checkoutStep = job.steps.find((s) => s.uses && s.uses.startsWith('actions/checkout'));
  assert.ok(checkoutStep, 'must have checkout step');
  assert.equal(
    checkoutStep.with.ref,
    'refs/pull/${{ github.event.issue.number }}/merge',
    'on-demand checkout must use PR merge ref, not default branch',
  );
});

for (const file of ['ai-review.yml', 'ai-review-reusable.yml']) {
  test(`${file}: /review refuses fork pull requests before it checks anything out`, () => {
    const job = loadWorkflow(file).jobs['review-on-demand'];
    const [guard, second] = job.steps;
    assert.equal(guard.uses, 'actions/github-script@v7', 'the first step must be the fork guard');
    assert.match(guard.with.script, /pulls\.get/);
    assert.match(guard.with.script, /pr\.head\.repo \? pr\.head\.repo\.full_name/, 'a deleted head repository must be refused');
    assert.match(guard.with.script, /setFailed/);
    assert.match(second.uses, /^actions\/checkout@/, 'checkout must come after the guard');
  });
}

test('the reusable workflow takes allowed-hosts and hands it to every call of the action', () => {
  const wf = loadWorkflow('ai-review-reusable.yml');
  const on = wf.on || wf[true];
  assert.equal(on.workflow_call.inputs['allowed-hosts'].default, '', 'no host is approved unless the caller lists it');
  for (const [name, job] of Object.entries(wf.jobs)) {
    const step = job.steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('openwt-vn/owlet-lens@'));
    assert.ok(step, `${name} calls the action`);
    assert.equal(step.with['allowed-hosts'], '${{ inputs.allowed-hosts }}', `${name} passes allowed-hosts`);
  }
});

test('action.yml has an allowed-hosts input that is empty by default', () => {
  const action = yaml.load(fs.readFileSync(path.join(workflowsDir, '..', '..', 'action.yml'), 'utf8'));
  assert.ok(action.inputs['allowed-hosts']);
  assert.notEqual(action.inputs['allowed-hosts'].required, true);
  assert.equal(action.inputs['allowed-hosts'].default, undefined);
});
