// TypeScript
// JScript functions for BasicList.Html. 
// This calls TRC APIs and binds to specific HTML elements from the page.
// Adapted from: https://raw.githubusercontent.com/hansy/trc-geofencing-plugin  

import * as trc from '../node_modules/trclib/trc2';
import * as html from '../node_modules/trclib/trchtml';
import * as trcFx from '../node_modules/trclib/trcfx';

declare var $: any; // external definition for JQuery

declare var google: any; // external definition for google map 
declare var randomColor: any; // from randomColor()

export class MyPlugin {
    private _sheet: trc.Sheet;
    private _options: trc.PluginOptionsHelper;

    private _info: trc.ISheetInfoResult;
    private _data: trc.ISheetContents;
    private _map: any;
    private _markers: any; // map markers; { recId: marker }
    private _polygons: any; //polylines/polygons; { sheetId: polygon/polyline }


    // Entry point called from brower. 
    // This creates real browser objects and passes in. 
    public static BrowserEntry(
        sheet: trc.ISheetReference,
        opts: trc.IPluginOptions,
        next: (plugin: MyPlugin) => void
    ): void {
        var trcSheet = new trc.Sheet(sheet);
        var opts2 = trc.PluginOptionsHelper.New(opts, trcSheet);

        // Do any IO here...

        trcSheet.getInfo((info) => {
            trcSheet.getSheetContents((data) => {
                trcSheet.getChildren(children => {
                    var plugin = new MyPlugin(trcSheet, info, data, children);

                    next(plugin);
                });
            });
        });

    }

    public constructor(
        sheet: trc.Sheet,
        info: trc.ISheetInfoResult,
        data: trc.ISheetContents,
        children: trc.IGetChildrenResultEntry[]) {
        this._sheet = sheet;
        this._data = data;
        this._info = info;
        this._map = this.initMap(info.Latitute, info.Longitude);
        this._markers = {};
        this._polygons = {};

        this.addMarkers();
        this.initDrawingManager(this._map); // adds drawing capability to map


        // $$$ Load existing Children  
    }


    // add drawing capability to map
    private initDrawingManager(map: any) {
        var drawingManager = new google.maps.drawing.DrawingManager({
            drawingMode: google.maps.drawing.OverlayType.POLYGON,
            drawingControlOptions: {
                position: google.maps.ControlPosition.TOP_CENTER,
                drawingModes: [
                    google.maps.drawing.OverlayType.POLYGON
                ]
            },
            polygonOptions: {
                editable: true
            }
        });

        // add event listener for when shape is drawn
        google.maps.event.addListener(drawingManager, 'overlaycomplete', (event: any) => {
            var polygon = event.overlay;
            var recIds = this.getPolygonIds(polygon);

            if (recIds.length === 0) {
                alert("No records found in polygon");
                event.overlay.setMap(null); // remove polygon
            } else {
                var walklistName = prompt("Name of walklist");


                if (walklistName === null) {
                    event.overlay.setMap(null); // remove polygon
                } else if (walklistName === "") {
                    alert("Walklist name can't be empty");
                    event.overlay.setMap(null);
                } else {
                    this.createWalklist(walklistName, recIds, polygon);
                }

            }
        });

        drawingManager.setMap(map);
    }


    // function to be returned in the event a checkbox is clicked
    private assignedCheckboxClickFx(sheetId: string) {
        var outer = this;
        return function (event: any)  {
            if (this.checked) {
                outer.setMarkersOpacity(sheetId, 0.2);
                outer.setPolygonOpacity(sheetId, 0.2);
            } else {
                outer.setMarkersOpacity(sheetId, 1);
                outer.setPolygonOpacity(sheetId, 1);
            }
        };
    }



    // remove polygon/polyline from global var _polygons
    private removeGlobalPolygon(sheetId: string) {
        var polygon = this._polygons[sheetId];
        polygon.setMap(null);
        delete this._polygons[sheetId];
    }

    // remove walklist from sidebar
    private removeWalklist(sheetId: string) {
        var tr = document.getElementById(sheetId);
        tr.parentNode.removeChild(tr);
    }

    // unassign marker from child sheet
    private removeMarkerSheetId(sheetId: string) {
        for (var id in this._markers) {
            var marker = this._markers[id];
            if (marker.sheetId === sheetId) {
                marker.sheetId = "";
            }
        }
    }

    private setMarkersOpacity(sheetId: string, opacity: number) {
        for (var id in this._markers) {
            var marker = this._markers[id];
            if (marker.sheetId === sheetId) {
                marker.setOpacity(opacity);
            }
        }
    }

    private setPolygonOpacity(sheetId: string, opacity: number) {
        var polygon = this._polygons[sheetId];
        polygon.setOptions({ strokeOpacity: opacity });
    }


    // function to be returned when delete 'x' is clicked
    private deleteWalklistClickFx(sheetId: string) {
        return  (event: any) => {
            var remove = confirm("Do you wish to delete this walklist?");

            if (remove) {
                // $$$

                // trcDeleteChildSheet(_sheet, sheetId, function() 
                {
                    this.removeWalklist(sheetId);
                    this.removeGlobalPolygon(sheetId);
                    this.removeMarkerSheetId(sheetId);
                };
            }
        }
    }

    // $$$ count should be 'number'
    // add walklist to sidebar
    private appendWalklist(name: string, sheetId: string, count: any, color: any) {
        var tr = document.createElement('tr');
        tr.setAttribute('style', 'border-left: 10px solid ' + color);
        tr.setAttribute('id', sheetId);

        // add name column
        var tdName = document.createElement('td');
        tdName.innerHTML = name;
        tr.appendChild(tdName);

        // add record count column
        var tdCount = document.createElement('td');
        tdCount.innerHTML = count;
        tdCount.setAttribute('class', 'record-count');
        tr.appendChild(tdCount);

        // add assigned checkbox column
        var tdCheckbox = document.createElement('td');
        var checkbox = document.createElement('input');
        checkbox.setAttribute('type', 'checkbox');
        checkbox.onclick = this.assignedCheckboxClickFx(sheetId);
        tdCheckbox.appendChild(checkbox);
        tr.appendChild(tdCheckbox);

        // add delete column
        var tdDelete = document.createElement('td');
        tdDelete.innerHTML = "x";
        tdDelete.setAttribute('class', 'delete-walklist-btn');
        tdDelete.onclick = this.deleteWalklistClickFx(sheetId);
        tr.appendChild(tdDelete);

        var walklistsEl = document.getElementById('walklists');
        var tbody = walklistsEl.getElementsByTagName('tbody')[0];

        tbody.appendChild(tr);

        // $('#walklists').append("<tr style='border-left: 10px solid "+color+"' id='"+sheetId+"'><td>"+name+"</td><td>"+count+"</td><td><input type='checkbox'></td></tr>")
    }

    private createWalklist(name: string, ids: string[], polygon: any) {
        //trcCreateChildSheet(_sheet, name, ids, function(childSheetRef) 
        {
            var color = randomColor();
            //var sheetId = childSheetRef.SheetId;
            var sheetId = "ID_" + name; // $$$

            this.addPolygonResizeEvents(polygon, sheetId);
            this.fillPolygon(polygon, color);
            this.globallyAddPolygon(polygon, sheetId);
            this.appendWalklist(name, sheetId, ids.length, color);
            this.updateMarkersWithSheetId(ids, sheetId);
        };
    }

    // add child sheet id to markers with lat/lng inside walklist
    private updateMarkersWithSheetId(ids: string[], sheetId: string) {
        var total = ids.length;

        for (var i = 0; i < total; i++) {
            var id = ids[i];
            this._markers[id].sheetId = sheetId;
        }
    }

    // adds polygon/polyline to global var _polygons
    private globallyAddPolygon(polygon: any, sheetId: string) {
        this._polygons[sheetId] = polygon;
    }

    private fillPolygon(polygon: any, color: any) {
        polygon.setOptions({
            fillColor: color,
            fillOpacity: 1
        });
    }

    private updateWalklist(ids : string[], sheetId :string) {
        /* $$$
        trcPatchChildSheetRecIds(_sheet, sheetId, ids, function() {
            updateRecordNum(sheetId, ids.length);
        });
        */
        }


    // event listeners for when polygon shape is modified
    private addPolygonResizeEvents(polygon: any, sheetId: string) {
        google.maps.event.addListener(polygon.getPath(), 'set_at', () => {
            this.updateWalklist(this.getPolygonIds(polygon), sheetId);
        });

        google.maps.event.addListener(polygon.getPath(), 'insert_at',  () => {
            this.updateWalklist(this.getPolygonIds(polygon), sheetId);
        });
    }

    // return rec ids within a polygon
    private getPolygonIds(polygon: any) : string[] {
        var ids: string[] = [];
        var numRows = this._info.CountRecords;

        for (var i = 0; i < numRows; i++) {
            var id = this._data["RecId"][i];
            var lat = this._data["Lat"][i];
            var lng = this._data["Long"][i];

            if (this.isInsidePolygon(lat, lng, polygon)) {
                ids.push(id);
            }
        }

        return ids;
    }


    // returns true if lat/lng coordinates are inside drawn polygon,
    // false otherwise
    private isInsidePolygon(lat: any, lng: any, poly: any) {
        var coords = new google.maps.LatLng(lat, lng);

        var result = google.maps.geometry.poly.containsLocation(coords, poly);
        return result;
    }

    // Initialize Google Map
    private initMap(lat: number, lng: number) {
        var coords = new google.maps.LatLng(lat, lng);

        var mapOptions = {
            zoom: 16,
            center: coords,
            mapTypeId: google.maps.MapTypeId.ROADMAP
        };

        var mapEl = document.getElementById("map");
        // need to give element height for GMap to render, so add 'map' CSS
        // class which has height rule
        mapEl.setAttribute('class', 'map');

        var gmap = new google.maps.Map(mapEl, mapOptions);

        return gmap;
    }




    // loops through sheet records, passing their lat/lng 
    // to 'addMarker' function
    private addMarkers() {
        var records = this._info.CountRecords;

        for (var i = 0; i < records; i++) {
            var recId = this._data["RecId"][i];
            var lat = this._data["Lat"][i];
            var lng = this._data["Long"][i];

            this.addMarker(lat, lng, recId);
        }
    }

    // adds map marker based on last/lng
    private addMarker(lat: any, lng: any, recId: string) {
        var latLng = new google.maps.LatLng(lat, lng);
        var marker = new google.maps.Marker({
            position: latLng,
            map: this._map,
            id: recId,
            sheetId: ""
        });

        this._markers[recId] = marker;
    }



}
