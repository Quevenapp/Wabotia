import React from "react";
import { Pill } from "../../../ui";
import { statusTones } from "../shared";
export function StagePill({
  status,
  label,
}: {
  status: string;
  label: string;
}) {
  return <Pill tone={statusTones[status] || "muted"}>{label}</Pill>;
}
