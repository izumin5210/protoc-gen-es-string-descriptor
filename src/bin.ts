#!/usr/bin/env node
import { runNodeJs } from "@bufbuild/protoplugin";
import { plugin } from "./plugin.js";

runNodeJs(plugin);
