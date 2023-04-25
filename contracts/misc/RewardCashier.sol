// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.0 <0.8.0;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/cryptography/MerkleProof.sol";
import "../utils/SafeDecimalMath.sol";

contract RewardCashier is Ownable {
    using SafeDecimalMath for uint256;

    address public immutable token;
    uint256 public immutable deadline;

    mapping(uint256 => bytes32) public roots;
    mapping(uint256 => uint256) public ratios;
    mapping(address => uint256) public claimed;

    uint256 public currentVersion;

    constructor(address token_, uint256 deadline_) public {
        token = token_;
        deadline = deadline_;
    }

    function claim(
        address account,
        uint256 amount,
        uint256 version,
        bytes32[] calldata merkleProof
    ) external {
        require(block.timestamp < deadline, "Deadline passed");
        require(claimed[account] < version, "Already claimed");
        require(version > 0 && version <= currentVersion, "Invalid version");

        bytes32 leaf = keccak256(abi.encodePacked(keccak256(abi.encode(account, amount, version))));
        require(checkValidity(merkleProof, roots[version], leaf), "Invalid proof");

        claimed[account] = version;
        uint256 reward = amount.multiplyDecimal(ratios[version]);
        IERC20(token).transfer(account, reward);
    }

    function checkValidity(
        bytes32[] calldata _merkleProof,
        bytes32 root,
        bytes32 leaf
    ) public pure returns (bool) {
        require(MerkleProof.verify(_merkleProof, root, leaf), "Incorrect proof");
        return true;
    }

    function addNewRoot(
        bytes32 root,
        uint256 totalRewards,
        uint256 totalShares
    ) external onlyOwner {
        currentVersion++;
        roots[currentVersion] = root;
        ratios[currentVersion] = totalRewards.divideDecimal(totalShares);
    }

    function drain() external onlyOwner {
        require(block.timestamp >= deadline);
        IERC20(token).transfer(owner(), IERC20(token).balanceOf(address(this)));
    }
}
