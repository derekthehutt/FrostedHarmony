'use strict';

// Starts the "Fix a vulnerable package" GitHub Action (.github/workflows/fix-vulnerability.yml) and
// reads its recent runs. The action updates the package on a new branch, runs the tests and opens a
// pull request; nothing changes on the website until that pull request is merged and deployed.
//
// Needs a fine-grained GitHub token limited to the website's repository with the permission
// "Actions: Read and write" (no other access).

const WORKFLOW = 'fix-vulnerability.yml';
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
// npm package names; never starting with "-", so a name can't be read as an npm option.
const PACKAGE = /^(?:@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*$/;
const TIMEOUT_MS = 20_000;

function createGithubActions({ repo, token, fetchImpl = (...args) => fetch(...args) }) {
  async function call(method, pathname, body) {
    const currentRepo = repo();
    const currentToken = token();
    if (!currentRepo || !REPO.test(currentRepo) || !currentToken) {
      const err = new Error('GitHub is not set up yet. Add the repository and a GitHub token under Settings → Security updates.');
      err.status = 400;
      throw err;
    }
    let res;
    try {
      res = await fetchImpl(`https://api.github.com/repos/${currentRepo}${pathname}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${currentToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const error = new Error(`Could not reach GitHub: ${err.message}`);
      error.status = 502;
      throw error;
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const hints = {
        401: 'GitHub rejected the token (expired or mistyped). Create a new one and save it in Settings.',
        403: 'The GitHub token is missing the "Actions: Read and write" permission for this repository.',
        404: 'GitHub could not find the repository or the fix-vulnerability workflow. Check the repository name, and that the workflow is on the main branch.',
        422: 'GitHub refused to start the workflow (is the workflow on the main branch?).',
      };
      const error = new Error(`${hints[res.status] || `GitHub answered HTTP ${res.status}.`}${data.message ? ` (${String(data.message).slice(0, 200)})` : ''}`);
      error.status = 502;
      throw error;
    }
    return data;
  }

  // Starts the workflow for one package. version: the first fixed version, or '' for the newest.
  async function requestFix({ package: name, version = '', advisory = '' }) {
    if (!PACKAGE.test(String(name || '')) || String(name).length > 214) throw Object.assign(new Error('Invalid package name.'), { status: 400 });
    await call('POST', `/actions/workflows/${WORKFLOW}/dispatches`, { ref: 'main', inputs: { package: name, version: version || '', advisory: advisory || '' } });
    return { runsUrl: `https://github.com/${repo()}/actions/workflows/${WORKFLOW}`, pullsUrl: `https://github.com/${repo()}/pulls` };
  }

  async function recentRuns() {
    const data = await call('GET', `/actions/workflows/${WORKFLOW}/runs?per_page=10`);
    return (data && Array.isArray(data.workflow_runs) ? data.workflow_runs : []).map((run) => ({
      id: run.id,
      title: String(run.display_title || run.name || '').slice(0, 200),
      status: String(run.status || ''),
      conclusion: run.conclusion ? String(run.conclusion) : null,
      createdAt: run.created_at || null,
      url: typeof run.html_url === 'string' && run.html_url.startsWith('https://github.com/') ? run.html_url : null,
    }));
  }

  const configured = () => Boolean(repo() && REPO.test(repo()) && token());

  return { requestFix, recentRuns, configured };
}

module.exports = { createGithubActions, REPO, PACKAGE, WORKFLOW };
