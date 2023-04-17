// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.0 <0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/cryptography/MerkleProof.sol";

contract RewardCashier is Ownable {
    address public immutable token;

    mapping(uint256 => bytes32) public roots;
    mapping(address => uint256) public claimed;

    uint256 public currentVersion;

    constructor(address token_) public {
        token = token_;
    }

    function claim(
        address account,
        uint256 amount,
        uint256 version,
        bytes32[] calldata merkleProof
    ) external {
        require(claimed[account] < version, "Already claimed");
        require(version > 0 && version <= currentVersion, "Invalid version");

        bytes32 leaf = keccak256(abi.encodePacked(account, amount, version));
        require(checkValidity(merkleProof, roots[version], leaf), "Invalid proof");

        claimed[account] = version;
        IERC20(token).transfer(account, amount);
    }

    function checkValidity(
        bytes32[] calldata _merkleProof,
        bytes32 root,
        bytes32 leaf
    ) public pure returns (bool) {
        require(MerkleProof.verify(_merkleProof, root, leaf), "Incorrect proof");
        return true;
    }

    function addNewRoot(bytes32 root_) external onlyOwner {
        currentVersion++;
        roots[currentVersion] = root_;
    }
}
