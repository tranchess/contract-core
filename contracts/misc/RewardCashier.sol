// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.0 <0.8.0;
pragma experimental ABIEncoderV2;
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "../utils/SafeDecimalMath.sol";

contract RewardCashier is Ownable {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    address public immutable token;
    uint256 public immutable deadline;

    mapping(uint256 => bytes32) public roots;
    mapping(uint256 => uint256) public ratios;
    mapping(address => uint256) public nextClaimableVersion;

    uint256 public currentVersion;

    constructor(address token_, uint256 deadline_) public {
        token = token_;
        deadline = deadline_;
    }

    function claim(
        uint256[] calldata amounts,
        uint256[] calldata versions,
        bytes32[][] calldata merkleProofs
    ) external returns (uint256) {
        require(block.timestamp < deadline, "Deadline passed");
        require(versions.length > 0, "No version");
        require(nextClaimableVersion[msg.sender] <= versions[0], "Already claimed");
        require(versions[versions.length - 1] < currentVersion, "Invalid version");

        uint256 reward = 0;
        for (uint256 i = 0; i < versions.length; i++) {
            if (i > 0) require(versions[i - 1] < versions[i], "Invalid version");
            bytes32 leaf =
                keccak256(
                    abi.encodePacked(keccak256(abi.encode(msg.sender, amounts[i], versions[i])))
                );
            require(MerkleProof.verify(merkleProofs[i], roots[versions[i]], leaf), "Invalid proof");
            reward = reward.add(amounts[i].multiplyDecimal(ratios[versions[i]]));
        }

        nextClaimableVersion[msg.sender] = versions[versions.length - 1] + 1;
        IERC20(token).transfer(msg.sender, reward);
        return reward;
    }

    function addNewRoot(
        bytes32 root,
        uint256 totalRewards,
        uint256 totalShares
    ) external onlyOwner {
        roots[currentVersion] = root;
        ratios[currentVersion] = totalRewards.divideDecimal(totalShares);
        currentVersion++;
    }

    function drain() external onlyOwner {
        require(block.timestamp >= deadline);
        IERC20(token).transfer(owner(), IERC20(token).balanceOf(address(this)));
    }
}
