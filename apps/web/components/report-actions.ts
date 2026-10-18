/**
 * How many of the report's action buttons stand on one line of their grid
 * where it has room for them: all of up to four, and three of five.
 */
export const columnsFor = (count: number): number => (count > 4 ? 3 : count);
