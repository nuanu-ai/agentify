/** The same words wherever a switch is about products published by code. */
export const codeProducts = (count: number | null): string =>
  count === null
    ? "the products your code published"
    : count === 1
      ? "the product your code published"
      : `the ${count.toLocaleString("en-US")} products your code published`;

/** Said before a Connect: nothing changes for the code's products until the shop's keys arrive. */
export const offSaleOnKeys = (count: number | null): string =>
  `${codeProducts(count)} ${count === 1 ? "goes" : "go"} off sale`;

export const comeBack = (count: number | null): string => {
  const said = codeProducts(count);
  return `${said.charAt(0).toUpperCase()}${said.slice(1)} ${count === 1 ? "comes" : "come"} back paused.`;
};
