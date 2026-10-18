// Is a counsellor reachable right now, and if not, when next?
//
// Timezone handling uses Intl.DateTimeFormat rather than a date library, to hold
// the repo's no-new-dependencies line. `formatToParts` with a `timeZone` gives
// the wall-clock weekday and time in that zone directly, which is the only
// question being asked here — no arithmetic on UTC offsets, so DST is handled by
// the platform rather than by us.

const { asPlainLines } = require('./crisisResources');

const WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

// Wall-clock weekday + minutes-from-midnight in the given zone.
const localParts = (date, timezone) => {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || DEFAULT_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
  } catch {
    // An invalid IANA name would otherwise throw on every message send.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: DEFAULT_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
  }

  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  // 'en-US' renders midnight as hour 24 in some ICU versions; normalise it.
  const hour = Number(lookup.hour) % 24;

  return {
    weekday: WEEKDAY_INDEX[lookup.weekday] ?? 0,
    minutes: hour * 60 + Number(lookup.minute),
  };
};

const formatMinute = (minute) => {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  const suffix = h < 12 ? 'am' : 'pm';
  const display = h % 12 === 0 ? 12 : h % 12;
  return m === 0
    ? `${display}${suffix}`
    : `${display}:${String(m).padStart(2, '0')}${suffix}`;
};

const normalizeWindows = (workingHours) =>
  (workingHours?.days || [])
    .filter(
      (d) =>
        Number.isFinite(d?.weekday) &&
        Number.isFinite(d?.startMinute) &&
        Number.isFinite(d?.endMinute) &&
        d.endMinute > d.startMinute,
    )
    .map((d) => ({
      weekday: Number(d.weekday),
      startMinute: Number(d.startMinute),
      endMinute: Number(d.endMinute),
    }));

// A counsellor with the feature off, or with no usable windows configured, is
// treated as always available — never auto-reply on a blank configuration.
const isWithinWorkingHours = (workingHours, { now = new Date(), fallbackTimezone = '' } = {}) => {
  if (!workingHours?.enabled) return true;

  const windows = normalizeWindows(workingHours);
  if (!windows.length) return true;

  const timezone = workingHours.timezone || fallbackTimezone || DEFAULT_TIMEZONE;
  const { weekday, minutes } = localParts(now, timezone);

  return windows.some(
    (w) =>
      w.weekday === weekday &&
      minutes >= w.startMinute &&
      minutes < w.endMinute,
  );
};

// "Monday at 9am" — the next window that opens, scanning at most a week ahead.
const describeNextWindow = (workingHours, { now = new Date(), fallbackTimezone = '' } = {}) => {
  const windows = normalizeWindows(workingHours);
  if (!windows.length) return '';

  const timezone = workingHours.timezone || fallbackTimezone || DEFAULT_TIMEZONE;
  const { weekday, minutes } = localParts(now, timezone);

  for (let offset = 0; offset < 7; offset += 1) {
    const day = (weekday + offset) % 7;
    const candidates = windows
      .filter((w) => w.weekday === day)
      .filter((w) => offset > 0 || w.startMinute > minutes)
      .sort((a, b) => a.startMinute - b.startMinute);

    if (candidates.length) {
      const when = formatMinute(candidates[0].startMinute);
      if (offset === 0) return `later today at ${when}`;
      if (offset === 1) return `tomorrow at ${when}`;
      return `${DAY_NAMES[day]} at ${when}`;
    }
  }
  return '';
};

const buildAfterHoursMessage = (workingHours, options = {}) => {
  const next = describeNextWindow(workingHours, options);
  const opening = next
    ? `Thanks for your message. Your counsellor is not available right now. They are back ${next} and will see this then.`
    : 'Thanks for your message. Your counsellor is not available right now and will see this when they are back.';

  return [
    opening,
    '',
    'If you need to talk to someone straight away, these lines are open 24/7:',
    ...asPlainLines().map((line) => `• ${line}`),
    '',
    'This is an automated reply.',
  ].join('\n');
};

module.exports = {
  isWithinWorkingHours,
  describeNextWindow,
  buildAfterHoursMessage,
  DEFAULT_TIMEZONE,
};
