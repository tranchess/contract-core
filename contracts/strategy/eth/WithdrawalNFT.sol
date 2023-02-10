// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract WithdrawalNFT is ERC721 {
    struct SVGParams {
        uint256 tokenId;
    }

    constructor(string memory name_, string memory symbol_) public ERC721(name_, symbol_) {}

    function generateSVG(SVGParams memory params) internal pure returns (string memory svg) {
        return
            string(
                abi.encodePacked(
                    '<svg width="290" height="500" viewBox="0 0 290 500" xmlns="http://www.w3.org/2000/svg"',
                    " xmlns:xlink='http://www.w3.org/1999/xlink'>",
                    generateSVGDefs(params),
                    "</svg>"
                )
            );
    }

    function generateSVGDefs(SVGParams memory params) private pure returns (string memory svg) {
        svg = string(abi.encodePacked("<defs>", params.tokenId, "</defs>"));
    }
}
