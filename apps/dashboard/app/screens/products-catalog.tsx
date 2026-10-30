import type { CardsView } from "../../src/views.js";
import { Frame } from "../components/frame.js";
import { AllSelling, CardsScreen } from "./cards.js";

export function ProductsCatalog({ view, base }: Readonly<{ view: CardsView; base: string }>) {
  return (
    <Frame tab="products" title="Products" action={<AllSelling view={view} />}>
      <CardsScreen view={view} base={base} />
    </Frame>
  );
}
