import { it } from "vitest";
import { i2Harness } from "./os-i2-harness";
import { clinicalChannel, clinicalChannels } from "./os-i2-scenarios";
it.each(clinicalChannels)("prontuário — barreira de %s", channel => clinicalChannel(i2Harness(), channel), 60000);
