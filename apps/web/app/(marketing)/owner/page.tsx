import { permanentRedirect } from "next/navigation";

/** The owner landing is the front page now; this address is kept for links already shared. */
export default function OwnerPage() {
  permanentRedirect("/");
}
