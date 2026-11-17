import { dirname } from "node:path";

import { pipelineAgentDir, preparePipelineAgentDir, resolveRole, resolveRoleModel } from "@idd/lane";

/**
 * The engine prepares a conversation's role agent dir in this child, not in its own process: the preparation
 * runs pi's catalog synchronously (and can fetch a gateway's price list) and would freeze the engine's event
 * loop and every other conversation while it does. The role name is argv[2], the model definition's name argv[3].
 *
 * Only ever run as a child; imported by nothing.
 */
const name = process.argv[2];
if (name) {
  const modelName = process.argv[3];
  const role = modelName ? resolveRoleModel(name, modelName) : resolveRole(name);
  preparePipelineAgentDir(dirname(pipelineAgentDir(role)), role);
  process.stdout.write("ok\n");
  process.exit(0);
}
