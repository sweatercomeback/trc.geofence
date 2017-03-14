import * as trc from '../node_modules/trclib/trc2';

export class FilterArea {
  private _id: string;
  private _container: HTMLElement;
  private _showForm: boolean;
  private _formContainer: HTMLElement;
  private _form: HTMLFormElement;
  private _sheet: trc.Sheet;

  constructor(id: string, sheet: trc.Sheet) {
        this._id = id;
        this._sheet = sheet;
        //Build 'Filter HTML' in designated container
        this._container = document.getElementById(this._id);
        this.injectHtml();
  }

  injectHtml() {
      let formHtml = '<form id="filterarea-form"><input type="text" name="filter-text" /><input type="submit" value="Go" /></form>';
      this._container.innerHTML = `<a href="#" id="filterarea-toggle">Add Filter</a><div style="display: none;" id="filterarea-form-container">${formHtml}</div>`;
      this.bindEvents();
  }
  bindEvents() {
    this._container.addEventListener("click", (e: any) => {
      if(e.target && e.target.getAttribute('id') === 'filterarea-toggle') {
        this._showForm = !this._showForm;
        this.toggleForm();
      }
    });
  }
  toggleForm() {
    this._formContainer = document.getElementById("filterarea-form-container");
    this._form = <HTMLFormElement>document.getElementById('filterarea-form');
    if(this._showForm) {
      this.showForm();
    } else {
      this.hideForm();

    }
  }
  showForm() {
    //Bind Form Submit Event
    this._form.addEventListener('submit', this.handleFormSubmit.bind(this), false);
    //Show Form
    this._formContainer.style.display = 'block';
  }
  hideForm() {
    //Hide Form
    this._formContainer.style.display = 'none';
    //Unbind Form Submit Event
    this._form.removeEventListener('submit', this.handleFormSubmit, false);
    this._form.reset();
  }
  handleFormSubmit(e: any) {
    e.preventDefault();
    let filterText = ((<HTMLInputElement>this._form.elements[0]).value);
    if(!this.validateFilterText(filterText)) {
        alert('Invalid Filter');
        return false;
    };

    var walklistName = prompt('Name of walklist');
    if(walklistName.length === 0) {
        alert('Invalid Name');
        return false;
    };
    this._sheet.createChildSheetFromFilter(walklistName, filterText, false, (sheet: trc.Sheet) => {}, (error: trc.ITrcError) => {
      alert('Unable to Create Child Sheet')
    });
    return false;
  }
  validateFilterText(text :string) {
    if(text.length === 0) {
      return false;
    }
    return true;
  }
}
