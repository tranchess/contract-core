import fs = require("fs");
import path = require("path");
import { strict as assert } from "assert";
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
    module: string
): T {
    const dir = getAddressDir(hre);
    const candidates = listAddressFile(dir, module);
    assert.ok(candidates.length > 0, `No address file of module '${module}' is found`);
    assert.ok(candidates.length === 1, `Multiple address files of module '${module}' are found`);
    const [filename] = candidates;
    const addresses: T = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf-8"));
    assert.ok(addresses.time, `Malformed address file '${filename}'`);
    assert.ok(addresses.gitVersion, `Malformed address file '${filename}'`);
    assert.strictEqual(addresses.chainId, hre.network.config.chainId, "Chain ID mismatched");
    return addresses;
}
