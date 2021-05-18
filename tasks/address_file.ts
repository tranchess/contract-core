import fs = require("fs");
import path = require("path");
import { execSync } from "child_process";
import { questionInt } from "readline-sync";
import editJsonFile = require("edit-json-file");
import { ETH_CHAIN_ID } from "../config";

const ADDRESS_FILE_DIR = path.join(__dirname, "..", "deploy");

export function getAddressFilename(module: string): string {
    const now = new Date();
    let s = now.toISOString();
    s = s.split(".")[0];
    s = s.replace("T", "_");
    s = s.split("-").join("");
    s = s.split(":").join("");
    return `${module}_address_${s}.json`;
}

export function createAddressFile(module: string): editJsonFile.JsonEditor {
    if (!fs.existsSync(ADDRESS_FILE_DIR)) {
        fs.mkdirSync(ADDRESS_FILE_DIR);
    }
    const filename = path.join(ADDRESS_FILE_DIR, getAddressFilename(module));
    if (fs.existsSync(filename)) {
        throw new Error(`Address file '${filename}' already exists`);
    }
    const addressFile = editJsonFile(filename, {
        stringify_eol: true,
        autosave: true,
    });

    addressFile.set("time", new Date().toJSON());
    let gitVersion;
    try {
        gitVersion = execSync("git rev-parse HEAD").toString().trim();
    } catch (e) {
        gitVersion = "N/A";
    }
    addressFile.set("git_version", gitVersion);
    addressFile.set("eth_chain_id", ETH_CHAIN_ID);
    return addressFile;
}

export function listAddressFile(module: string): string[] {
    if (fs.existsSync(ADDRESS_FILE_DIR) && fs.lstatSync(ADDRESS_FILE_DIR).isDirectory()) {
        const filenames = fs.readdirSync(ADDRESS_FILE_DIR);
        return filenames
            .filter((f) => f.endsWith(".json"))
            .filter((f) => f.startsWith(module + "_address_"))
            .sort();
    } else {
        return [];
    }
}

export async function selectAddressFile(
    module: string,
    filename: string
): Promise<{ readonly [contract: string]: string }> {
    if (filename === "" || filename === "latest") {
        const candidates = listAddressFile(module);
        if (candidates.length === 0) {
            throw new Error(`No address file of module '${module}' is found`);
        }
        if (filename === "latest") {
            filename = path.join(ADDRESS_FILE_DIR, candidates[candidates.length - 1]);
        } else {
            while (true) {
                // Ask user to select an address file
                console.log();
                console.table(
                    candidates.reduce(
                        (map, f, index) => ((map[index + 1] = f), map),
                        {} as { [key: number]: string }
                    )
                );
                const index = questionInt(
                    `Please choose an address file of module '${module}' [${candidates.length}]:`,
                    {
                        defaultInput: candidates.length.toString(),
                    }
                );
                if (index > 0 && index <= candidates.length) {
                    filename = path.join(ADDRESS_FILE_DIR, candidates[index - 1]);
                    break;
                }
                console.log("Error: index out of range");
            }
        }
    }
    return JSON.parse(fs.readFileSync(filename, "utf-8"));
}
