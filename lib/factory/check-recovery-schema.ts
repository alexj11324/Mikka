import { z } from "zod";
import { bindingSchema } from "./contract";

/** Outer planning tools supply only a binding, never the model answer/receipt. */
export const factoryCheckRecoverySchema = z
  .object({ binding: bindingSchema })
  .strict();
