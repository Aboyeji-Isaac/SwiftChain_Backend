/**
 * Returns the current date/time as a UTC Date object.
 */
export const nowUTC = (): Date => {
  return new Date();
};

/**
 * Parses a date string, number, or Date into a UTC Date object.
 */
export const toUTC = (date: Date | string | number): Date => {
  return new Date(date);
};

/**
 * Formats a date to an ISO 8601 string in UTC.
 */
export const toISOUTC = (date: Date): string => {
  return date.toISOString();
};
