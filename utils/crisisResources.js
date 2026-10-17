// The 24/7 crisis lines shown to a student who messages a counsellor outside
// their working hours.
//
// Server-side and single-source on purpose. These numbers used to live only in
// the dashboard component's props; a number that is wrong in one place and right
// in another is worse than one that is wrong everywhere, because nobody notices.
//
// Verify these against the current national directory before each release.

const CRISIS_RESOURCES = [
  {
    name: 'Tele-MANAS',
    detail: 'Government of India, 24/7, multilingual',
    phone: '14416',
  },
  {
    name: 'KIRAN Mental Health Helpline',
    detail: 'Ministry of Social Justice, 24/7',
    phone: '1800-599-0019',
  },
  {
    name: 'Childline India',
    detail: 'For anyone under 18, 24/7',
    phone: '1098',
  },
  {
    name: 'Emergency services',
    detail: 'If you or someone else is in immediate danger',
    phone: '112',
  },
];

const asPlainLines = () =>
  CRISIS_RESOURCES.map(
    (resource) => `${resource.name} — ${resource.phone} (${resource.detail})`,
  );

module.exports = { CRISIS_RESOURCES, asPlainLines };
