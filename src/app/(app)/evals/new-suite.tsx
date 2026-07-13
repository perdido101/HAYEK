"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { createSuite } from "../actions";

export function NewSuite() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();

  if (!open) return <Button onClick={() => setOpen(true)}>New suite</Button>;

  return (
    <div className="flex gap-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="suite name" autoFocus />
      <Button
        onClick={() =>
          start(async () => {
            const res = await createSuite(name);
            if ("id" in res) router.push(`/evals/${res.id}`);
          })
        }
        disabled={pending}
      >
        {pending ? "…" : "Create"}
      </Button>
    </div>
  );
}
