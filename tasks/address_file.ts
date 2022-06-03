import fs = require("fs");
import path = require("path");
import { strict as assert } from "assert";
import { questionInt } from "readline-sync";
import { execSync } from "child_process";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const ADDRESS_FILE_DIR = path.join(__dirname, "..", "deployed_addresses");

export interface Addresses {
    time: string;
    gitVersion: string;
    chainId: number;
}

export function newAddresses(hre: HardhatRuntimeEnvironment): Addresses {
    let gitVersion;
    try {
        gitVersion = execSync("git rev-parse HEAD").toString().trim();
    } catch (e) {
        gitVersion = "N/A";
    }
    return {
        time: new Date().toJSON(),
        gitVersion,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        chainId: hre.network.config.chainId!,
    };
}

let addressDir: string;

export function getAddressDir(hre: HardhatRuntimeEnvironment): string {
    if (!addressDir) {
        let name = `${hre.network.name}_${hre.network.config.chainId}`;
        if (hre.network.name === "hardhat") {
            name += "_" + Math.floor(new Date().getTime() / 1000).toString();
        }
        addressDir = path.join(ADDRESS_FILE_DIR, name);
    }
    return addressDir;
}

function newFilename(module: string): string {
    const now = new Date();
    let s = now.toISOString();
    s = s.split(".")[0];
    s = s.replace("T", "_");
    s = s.split("-").join("");
    s = s.split(":").join("");
    return `${module}_address_${s}.json`;
}

export function saveAddressFile<T extends Addresses>(
    hre: HardhatRuntimeEnvironment,
    module: string,
    addresses: T
): void {
    const dir = getAddressDir(hre);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const filename = path.join(dir, newFilename(module));
    if (fs.existsSync(filename)) {
        throw new Error(`Address file '${filename}' already exists`);
    }
    fs.writeFileSync(filename, JSON.stringify(addresses, null, 4));
}

export function listAddressFile(directory: string, module: string): string[] {
    if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory()) {
        const filenames = fs.readdirSync(directory);
        return filenames
            .filter((f) => f.endsWith(".json"))
            .filter((f) => f.startsWith(module + "_address_"))
            .sort();
    } else {
        return [];
    }
}

export function loadAddressFile<T extends Addresses>(
    hre: HardhatRuntimeEnvironment,
    module: string,
    interactive = false
): T {
    const dir = getAddressDir(hre);
    const candidates = listAddressFile(dir, module);
    let filename: string;
    if (interactive) {
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
                filename = candidates[index - 1];
                break;
            }
            console.log("Error: index out of range");
        }
    } else {
        assert.ok(candidates.length > 0, `No address file of module '${module}' is found`);
        assert.ok(
            candidates.length === 1,
            `Multiple address files of module '${module}' are found`
        );
        filename = candidates[0];
    }
    const addresses: T = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf-8"));
    assert.ok(addresses.time, `Malformed address file '${filename}'`);
    assert.ok(addresses.gitVersion, `Malformed address file '${filename}'`);
    assert.strictEqual(addresses.chainId, hre.network.config.chainId, "Chain ID mismatched");
    return addresses;
}
