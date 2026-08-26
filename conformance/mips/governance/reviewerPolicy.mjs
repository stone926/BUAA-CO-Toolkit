/**
 * Phase-0 approval identity policy.
 *
 * The value stored in an artifact is an auditable claim, not an identity
 * signature.  GitHub CODEOWNERS plus protected-branch review is the authority
 * that makes the claim trustworthy.
 */
export const phase0ApprovalReviewer = 'stone926';

const githubUsernamePattern = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export function isGithubUsername(value) {
  return typeof value === 'string' && githubUsernamePattern.test(value);
}

export function assertPolicyReviewer(value, context = 'reviewer') {
  if (!isGithubUsername(value)) {
    throw new Error(`${context} must be a GitHub username`);
  }
  if (value !== phase0ApprovalReviewer) {
    throw new Error(`${context} must be the phase-0 policy reviewer ${phase0ApprovalReviewer}`);
  }
  return value;
}

export function assertIndependentPolicyReviewer(value, author, context = 'reviewer') {
  assertPolicyReviewer(value, context);
  if (value === author) {
    throw new Error(`${context} must differ from author`);
  }
  return value;
}
