import { Button, Field } from "@agentify/ui";
import type { KeysView } from "../../src/keys.js";
import { PostForm } from "../components/post-form.js";

export function CreateKeyForm({ view, action }: Readonly<{ view: KeysView; action: string }>) {
  return (
    <PostForm action={action} className="issue" replace={false}>
      {(pending) => (
        <>
          <input type="hidden" name="intent" value="create-key" />
          <Field
            label="Key name"
            id="label"
            name="label"
            type="text"
            autoComplete="off"
            placeholder="Order worker, production"
            maxLength={100}
            defaultValue={view.typed}
            autoFocus={view.startNew}
            required
            {...(view.problem === null ? {} : { error: view.problem })}
          />
          <Button id="create-api-key" pending={pending}>
            Create key
          </Button>
        </>
      )}
    </PostForm>
  );
}
