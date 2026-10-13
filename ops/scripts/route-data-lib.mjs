/**
 * The data each route of a page was drawn with, read back out of the page's
 * HTML. React Router writes it into the page for the browser to draw again
 * with, as the first line of a stream handed to
 * `streamController.enqueue(...)`, in its own flattened form: one array of
 * every distinct value, in which an object is `{"_<index of a key>": <index
 * of its value>}`, an array is a list of indices, and a negative index stands
 * for null, undefined or a number JSON cannot write. A value is therefore not
 * written beside its name, and a pattern over the HTML cannot tell which name
 * a value belongs to.
 *
 * Plain objects, arrays and primitives are read. Anything else the stream can
 * carry (a date, a promise, an error) is refused with words rather than
 * guessed at, since the pages this reads carry none.
 */

const STANDS_FOR = new Map([
  [-5, null],
  [-7, undefined],
  [-2, Number.NaN],
  [-6, Number.POSITIVE_INFINITY],
  [-3, Number.NEGATIVE_INFINITY],
  [-4, -0],
]);

/** Every route's loader data on the page, by route id (`root`, `routes/scan.id`, ...). */
export function routeDataOf(html) {
  const call = html.match(/streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/);
  if (call === null) throw new Error("the page carries no route data");
  const values = JSON.parse(JSON.parse(call[1]));
  const read = (index) => {
    if (index < 0) {
      if (!STANDS_FOR.has(index)) throw new Error(`the route data names an unknown value ${index}`);
      return STANDS_FOR.get(index);
    }
    const value = values[index];
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      if (typeof value[0] === "string") {
        throw new Error(`the route data carries a value of kind "${value[0]}", which is not read`);
      }
      return value.map(read);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, at]) => {
        if (!/^_\d+$/.test(key)) throw new Error(`the route data carries an object of kind ${key}`);
        return [values[Number(key.slice(1))], read(at)];
      }),
    );
  };
  return read(0).loaderData;
}
