// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity >=0.6.10 <0.8.0;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "base64-sol/base64.sol";

import "../interfaces/IFundV3.sol";
import "../utils/HexString.sol";
import "../strategy/eth/EthPrimaryMarket.sol";

contract NonfungibleWithdrawalDescriptor {
    using HexStrings for uint256;

    struct SVGParams {
        uint256 tokenId;
    }

    function tokenURI(EthPrimaryMarket primaryMarket, uint256 tokenId)
        external
        view
        returns (string memory)
    {
        SVGParams memory params = SVGParams(tokenId);
        string memory name =
            _generateName(ERC20(IFundV3(primaryMarket.fund()).tokenUnderlying()).symbol());
        string memory description =
            _generateDescription(
                _escapeQuotes(primaryMarket.name()),
                _addressToString(address(primaryMarket))
            );
        string memory image = Base64.encode(bytes(_generateSVG(params)));

        return
            string(
                abi.encodePacked(
                    "data:application/json;base64,",
                    Base64.encode(
                        bytes(
                            abi.encodePacked(
                                '{"name":"',
                                name,
                                '", "description":"',
                                description,
                                '", "image": "',
                                "data:image/svg+xml;base64,",
                                image,
                                '"}'
                            )
                        )
                    )
                )
            );
    }

    function _generateName(string memory symbol) private pure returns (string memory) {
        return
            string(
                abi.encodePacked(
                    "Tranchess - ",
                    " - ",
                    _escapeQuotes(symbol),
                    " - ",
                    "Withdrawal Request"
                )
            );
    }

    function _generateDescription(string memory symbol, string memory primaryMarketAddress)
        private
        pure
        returns (string memory)
    {
        return
            string(
                abi.encodePacked(
                    "This NFT represents a withdrawal request in the Tranchess ",
                    symbol,
                    " primary market. ",
                    "The owner of this NFT can claim the redemption.\\n",
                    "\\nPrimary Market Address: ",
                    primaryMarketAddress
                )
            );
    }

    function _generateSVG(SVGParams memory params) private pure returns (string memory svg) {
        return
            string(
                abi.encodePacked(
                    '<svg width="290" height="500" viewBox="0 0 290 500" xmlns="http://www.w3.org/2000/svg"',
                    " xmlns:xlink='http://www.w3.org/1999/xlink'>",
                    _generateSVGDefs(params),
                    "</svg>"
                )
            );
    }

    function _generateSVGDefs(SVGParams memory params) private pure returns (string memory svg) {
        svg = string(abi.encodePacked("<defs>", params.tokenId, "</defs>"));
    }

    function _escapeQuotes(string memory symbol) private pure returns (string memory) {
        bytes memory symbolBytes = bytes(symbol);
        uint8 quotesCount = 0;
        for (uint8 i = 0; i < symbolBytes.length; i++) {
            if (symbolBytes[i] == '"') {
                quotesCount++;
            }
        }
        if (quotesCount > 0) {
            bytes memory escapedBytes = new bytes(symbolBytes.length + (quotesCount));
            uint256 index;
            for (uint8 i = 0; i < symbolBytes.length; i++) {
                if (symbolBytes[i] == '"') {
                    escapedBytes[index++] = "\\";
                }
                escapedBytes[index++] = symbolBytes[i];
            }
            return string(escapedBytes);
        }
        return symbol;
    }

    function _addressToString(address addr) private pure returns (string memory) {
        return (uint256(addr)).toHexString(20);
    }
}
