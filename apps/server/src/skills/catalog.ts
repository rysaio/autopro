import type { SkillManifest, SkillPackManifest } from "@secops-agent/shared";

const PACK_DEFINITIONS: Record<string, Omit<SkillPackManifest, "tools" | "mcpCompatible">> = {
  "secops-core": {
    id: "secops-core",
    name: "SecOps Core",
    description: "Read-only defensive triage, detection, asset, and evidence helpers.",
    version: "0.1.0",
    tags: ["secops", "read-only", "triage"]
  },
  "secops-actions": {
    id: "secops-actions",
    name: "SecOps Sandbox Actions",
    description: "Bounded local automation for sandbox case notes and preset environment inspection.",
    version: "0.1.0",
    tags: ["secops", "action", "sandbox"]
  },
  "secops-full-access": {
    id: "secops-full-access",
    name: "Full Access Gate",
    description: "Arbitrary local execution capability available when access level is set to full-access.",
    version: "0.1.0",
    tags: ["action", "full-access"]
  },
  "secops-wazuh": {
    id: "secops-wazuh",
    name: "Wazuh Platform",
    description: "Typed Wazuh tools for platform health, agent inventory, alert search, and audited Active Response actions.",
    version: "0.1.0",
    tags: ["secops", "wazuh", "siem", "active-response"]
  }
};

export function skillPacksFor(manifests: SkillManifest[]): SkillPackManifest[] {
  const byPack = new Map<string, SkillManifest[]>();
  for (const manifest of manifests) {
    const current = byPack.get(manifest.skillPackId) ?? [];
    current.push(manifest);
    byPack.set(manifest.skillPackId, current);
  }

  return [...byPack.entries()]
    .map(([packId, tools]) => {
      const definition = PACK_DEFINITIONS[packId] ?? {
        id: packId,
        name: packId,
        description: "External skill pack discovered from registered tool manifests.",
        version: "0.1.0",
        tags: ["external"]
      };
      return {
        ...definition,
        tools: tools.map((tool) => tool.id).sort(),
        mcpCompatible: tools.every((tool) => tool.mcpCompatible)
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
