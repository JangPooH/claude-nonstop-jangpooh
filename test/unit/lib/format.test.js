import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatSetupTokenExpiry } from '../../../lib/format.js';

describe('formatSetupTokenExpiry', () => {
  // Local time on purpose: the date is shown in the local zone
  const expiresAt = new Date(2027, 9, 18, 12, 0, 0);

  it('shows the days left and the estimated date', () => {
    assert.equal(formatSetupTokenExpiry({ expiresAt, daysLeft: 5 }), 'setup-token expires in ~5d (est. 2027-10-18)');
  });

  it('says expired today within the first day after expiry', () => {
    assert.equal(formatSetupTokenExpiry({ expiresAt, daysLeft: 0 }), 'setup-token expired today (est. 2027-10-18)');
    // Math.ceil gives -0 for a few hours past expiry
    assert.equal(formatSetupTokenExpiry({ expiresAt, daysLeft: -0 }), 'setup-token expired today (est. 2027-10-18)');
  });

  it('shows how long ago it expired', () => {
    assert.equal(formatSetupTokenExpiry({ expiresAt, daysLeft: -3 }), 'setup-token expired ~3d ago (est. 2027-10-18)');
  });
});
