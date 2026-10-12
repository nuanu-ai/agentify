import { permanentRedirect } from "next/navigation";

/** Kept so links already shared to this address still reach the front page. */
export default function OwnerPage() {
  permanentRedirect("/");
}
